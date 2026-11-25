import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { type ContentBlock, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type Note, type NoteInput, NotesApiError, type NotesClient } from "./notes-api.js";
import { listHeadings } from "./outline.js";
import { createMatcher, excerptMatches, type LineMatcher } from "./search.js";

const noteId = z.number().int().positive().describe("Note id, as returned by list_notes or search_notes.");
const attachmentPath = z
  .string()
  .min(1)
  .describe("Attachment path as written in the note's Markdown, e.g. \".attachments.42/figure.png\".");
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const textTypes = new Set(["application/json", "image/svg+xml"]);

export function createServer(notes: NotesClient): McpServer {
  const server = new McpServer({ name: "nextcloud-note-mcp", version: "0.1.0" });

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List notes without their content, newest first, one per line as tab-separated id, category, title and " +
        "last-modified time.",
      inputSchema: z.object({
        category: z.string().optional().describe("Only list notes in this category. Use \"\" for uncategorized notes."),
        favorite: z.boolean().optional().describe("Only list favorite notes."),
        modified_since: z
          .union([z.iso.datetime({ offset: true }), z.iso.date()])
          .optional()
          .describe("Only list notes modified at or after this ISO 8601 time. A bare date means midnight UTC."),
        limit: z.number().int().positive().optional().describe("Return at most this many notes."),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ category, favorite, modified_since, limit }) =>
      run(async () => {
        const since = modified_since === undefined ? undefined : Date.parse(modified_since) / 1000;
        const matching = (await notes.listNotes({ category }))
          .filter((note) => !favorite || note.favorite)
          .filter((note) => since === undefined || note.modified >= since)
          .sort((a, b) => b.modified - a.modified);
        if (matching.length === 0) return "No notes found.";
        const shown = matching.slice(0, limit);
        const rows = shown.map((note) => [note.id, note.category, note.title, formatTime(note.modified)].join("\t"));
        const omitted = matching.length - shown.length;
        return [
          "id\tcategory\ttitle\tmodified",
          ...rows,
          ...(omitted > 0 ? [`(${omitted} more notes not shown)`] : []),
        ].join("\n");
      }),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Case-insensitive search over note titles and contents. Returns only the matching lines with surrounding context " +
        "(grep style: `12:` marks a matching line, `11-` a context line), so call get_note only for notes you need in full.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Text to search for."),
        regex: z.boolean().default(false).describe("Treat query as a JavaScript regular expression."),
        category: z.string().optional().describe("Only search notes in this category."),
        context_lines: z.number().int().min(0).max(20).default(2).describe("Lines of context around each match."),
        ids_only: z.boolean().default(false).describe("Return only id, category and title of matching notes."),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, regex, category, context_lines, ids_only }) =>
      run(async () => {
        let matches: LineMatcher;
        try {
          matches = createMatcher(query, regex);
        } catch (error) {
          throw new ToolInputError(`Invalid regular expression: ${(error as Error).message}`);
        }
        const all = await notes.listNotesWithContent();
        const sections = all
          .filter((note) => category === undefined || note.category === category)
          .flatMap((note) => {
            const excerpt = excerptMatches(note.content, matches, context_lines);
            if (excerpt === "" && !matches(note.title)) return [];
            if (ids_only) return [`${note.id}\t${note.category}\t${note.title}`];
            return [`=== id=${note.id} [${note.category}] ${note.title} ===${excerpt === "" ? "" : `\n${excerpt}`}`];
          });
        return sections.length === 0 ? "No matches." : sections.join(ids_only ? "\n" : "\n\n");
      }),
  );

  server.registerTool(
    "get_note",
    {
      title: "Get note",
      description:
        "Read a note, in full or only a range of lines. For long notes, find the lines with get_note_outline or " +
        "search_notes first. The etag in the header is needed by update_note to replace the content.",
      inputSchema: z.object({
        id: noteId,
        start_line: z.number().int().positive().optional().describe("First line to return (1-based)."),
        end_line: z.number().int().positive().optional().describe("Last line to return, inclusive."),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ id, start_line, end_line }) =>
      run(async () => {
        if (start_line !== undefined && end_line !== undefined && end_line < start_line) {
          throw new ToolInputError("end_line must not be less than start_line.");
        }
        const note = await notes.getNote(id);
        const header = `${formatHeader(note)}\nreadonly: ${note.readonly}`;
        if (start_line === undefined && end_line === undefined) return `${header}\n\n${note.content}`;

        const lines = note.content.split("\n");
        const first = start_line ?? 1;
        const last = Math.min(end_line ?? lines.length, lines.length);
        if (first > lines.length) {
          throw new ToolInputError(`start_line ${first} is past the end of note ${id} (${lines.length} lines).`);
        }
        return `${header}\nlines: ${first}-${last} of ${lines.length}\n\n${lines.slice(first - 1, last).join("\n")}`;
      }),
  );

  server.registerTool(
    "get_note_outline",
    {
      title: "Get note outline",
      description:
        "List a note's Markdown headings with their line numbers (`12:## Heading`), to read one section " +
        "with get_note's start_line and end_line.",
      inputSchema: z.object({ id: noteId }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run(async () => {
        const note = await notes.getNote(id);
        const headings = listHeadings(note.content).map((heading) => `${heading.line}:${heading.text}`);
        const lineCount = note.content.split("\n").length;
        return `${formatHeader(note)}\nlines: ${lineCount}\n\n${headings.length === 0 ? "No headings." : headings.join("\n")}`;
      }),
  );

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description:
        "Create a note. Nextcloud may strip special characters from the title and category and appends a number " +
        "when the title already exists in the category, so use the returned values.",
      inputSchema: z.object({
        title: z.string().min(1),
        content: z.string().describe("Markdown body."),
        category: z.string().optional().describe("Category; use \"/\" to nest, e.g. \"Projects/Alpha\"."),
        favorite: z.boolean().optional(),
      }),
    },
    (input) => run(async () => `Created note.\n${formatHeader(await notes.createNote(input))}`),
  );

  server.registerTool(
    "edit_note",
    {
      title: "Edit note",
      description:
        "Replace an exact string in a note's content without sending the whole body. old_string must occur exactly once " +
        "unless replace_all is true; include surrounding text to make it unique.",
      inputSchema: z.object({
        id: noteId,
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().default(false),
      }),
    },
    ({ id, old_string, new_string, replace_all }) =>
      run(async () => {
        const note = await notes.getNote(id);
        const count = note.content.split(old_string).length - 1;
        if (count === 0) throw new ToolInputError(`old_string was not found in note ${id}.`);
        if (count > 1 && !replace_all) {
          throw new ToolInputError(
            `old_string occurs ${count} times in note ${id}. Add surrounding text to make it unique, or set replace_all.`,
          );
        }
        const content = note.content.replaceAll(old_string, () => new_string);
        const updated = await notes.updateNote(id, { content }, note.etag);
        return `Replaced ${count} occurrence(s).\n${formatHeader(updated)}`;
      }),
  );

  server.registerTool(
    "update_note",
    {
      title: "Update note",
      description:
        "Change a note's title, category or favorite flag, or replace its whole content. Only the given fields change. " +
        "Replacing content requires the etag from get_note; the update is refused if the note changed since then. " +
        "Prefer edit_note for partial changes to the content.",
      inputSchema: z.object({
        id: noteId,
        title: z.string().min(1).optional(),
        content: z.string().optional().describe("New Markdown body, replacing the whole content."),
        category: z.string().optional(),
        favorite: z.boolean().optional(),
        etag: z.string().optional().describe("etag from get_note. Required when content is given."),
      }),
    },
    ({ id, etag, ...fields }) =>
      run(async () => {
        if (fields.content !== undefined && etag === undefined) {
          throw new ToolInputError("etag is required when replacing content. Read it with get_note first.");
        }
        const input: NoteInput = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
        if (Object.keys(input).length === 0) throw new ToolInputError("Nothing to update.");
        return `Updated note.\n${formatHeader(await notes.updateNote(id, input, etag))}`;
      }),
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description: "Delete a note.",
      inputSchema: z.object({ id: noteId }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ id }) =>
      run(async () => {
        await notes.deleteNote(id);
        return `Deleted note ${id}.`;
      }),
  );

  server.registerTool(
    "add_attachment",
    {
      title: "Add attachment",
      description:
        "Upload a local file, such as a generated figure, as an attachment of a note. The note's content is not " +
        "changed: embed the returned path with edit_note, wrapped in angle brackets so that spaces in the file " +
        "name work, e.g. `![figure](<.attachments.42/my figure.png>)`. The Notes app does not display SVG images; " +
        "upload figures as PNG.",
      inputSchema: z.object({
        id: noteId,
        file_path: z.string().min(1).describe("Absolute path of the local file to upload."),
      }),
    },
    ({ id, file_path }) =>
      run(async () => {
        let file: Blob;
        try {
          file = await openAsBlob(file_path);
        } catch (error) {
          throw new ToolInputError(`Cannot read ${file_path}: ${(error as Error).message}`);
        }
        return `Attached as ${await notes.addAttachment(id, file, basename(file_path))}`;
      }),
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Get attachment",
      description:
        "Read an attachment of a note. PNG, JPEG, GIF and WebP images are returned as images; text files, " +
        "including SVG, as text.",
      inputSchema: z.object({ id: noteId, path: attachmentPath }),
      annotations: { readOnlyHint: true },
    },
    ({ id, path }) =>
      run(async () => {
        const { data, mimeType } = await notes.getAttachment(id, path);
        if (imageTypes.has(mimeType)) {
          return { type: "image", data: Buffer.from(data).toString("base64"), mimeType };
        }
        if (mimeType.startsWith("text/") || textTypes.has(mimeType)) return new TextDecoder().decode(data);
        throw new ToolInputError(`${path} is ${mimeType}; only PNG, JPEG, GIF, WebP and text files can be returned.`);
      }),
  );

  server.registerTool(
    "delete_attachment",
    {
      title: "Delete attachment",
      description: "Delete an attachment of a note. References to it in the note's content are not removed.",
      inputSchema: z.object({ id: noteId, path: attachmentPath }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ id, path }) =>
      run(async () => {
        await notes.deleteAttachment(id, path);
        return `Deleted attachment ${path} of note ${id}.`;
      }),
  );

  server.registerResource(
    "note",
    new ResourceTemplate("notes://{id}", {
      list: async () => ({
        resources: (await notes.listNotes()).map((note) => ({
          uri: `notes://${note.id}`,
          name: note.title,
          title: note.title,
          description: note.category === "" ? undefined : `Category: ${note.category}`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    { title: "Note", description: "A note's Markdown content.", mimeType: "text/markdown" },
    async (uri, { id }) => {
      if (typeof id !== "string" || !/^\d+$/.test(id)) throw new Error(`Invalid note URI: ${uri.href}`);
      const note = await notes.getNote(Number(id));
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: note.content }] };
    },
  );

  return server;
}

class ToolInputError extends Error {}

async function run(body: () => Promise<string | ContentBlock>) {
  try {
    const result = await body();
    return { content: [typeof result === "string" ? { type: "text" as const, text: result } : result] };
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof NotesApiError) {
      return { content: [{ type: "text" as const, text: error.message }], isError: true };
    }
    throw error;
  }
}

function formatHeader(note: Note): string {
  return [
    `id: ${note.id}`,
    `title: ${note.title}`,
    `category: ${note.category}`,
    `favorite: ${note.favorite}`,
    `modified: ${formatTime(note.modified)}`,
    `etag: ${note.etag}`,
  ].join("\n");
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}
