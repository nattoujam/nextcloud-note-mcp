import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type Note, type NoteInput, NotesApiError, type NotesClient } from "./notes-api.js";
import { createMatcher, excerptMatches, type LineMatcher } from "./search.js";

const noteId = z.number().int().positive().describe("Note id, as returned by list_notes or search_notes.");

export function createServer(notes: NotesClient): McpServer {
  const server = new McpServer({ name: "nextcloud-note-mcp", version: "0.1.0" });

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List notes without their content, one per line as tab-separated id, category, title and last-modified time.",
      inputSchema: z.object({
        category: z.string().optional().describe("Only list notes in this category. Use \"\" for uncategorized notes."),
        favorite: z.boolean().optional().describe("Only list favorite notes."),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ category, favorite }) =>
      run(async () => {
        const summaries = await notes.listNotes({ category });
        const rows = summaries
          .filter((note) => !favorite || note.favorite)
          .map((note) => [note.id, note.category, note.title, formatTime(note.modified)].join("\t"));
        return rows.length === 0 ? "No notes found." : ["id\tcategory\ttitle\tmodified", ...rows].join("\n");
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
      description: "Read one note in full. The etag in the header is needed by update_note to replace the content.",
      inputSchema: z.object({ id: noteId }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run(async () => {
        const note = await notes.getNote(id);
        return `${formatHeader(note)}\nreadonly: ${note.readonly}\n\n${note.content}`;
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

  return server;
}

class ToolInputError extends Error {}

async function run(body: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await body() }] };
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
