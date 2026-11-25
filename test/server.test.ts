import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { NotesClient } from "../src/notes-api.js";
import { createServer } from "../src/server.js";
import { FakeNotesStore } from "./fake-notes-api.js";
import { attachments as fixtureAttachments, config, notes as fixtureNotes } from "./fixtures.js";

const network = setupServer();
let store: FakeNotesStore;
let client: Client;
let closeHandler: () => Promise<void>;

beforeAll(() => network.listen({ onUnhandledFrame: "error" }));
afterAll(() => network.close());

beforeEach(async () => {
  store = new FakeNotesStore(fixtureNotes, fixtureAttachments);
  network.use(...store.handlers());
  client = await connect(new NotesClient(config));
});

afterEach(async () => {
  await client.close();
  await closeHandler();
  network.resetHandlers();
});

async function connect(notes: NotesClient): Promise<Client> {
  const handler = createMcpHandler(() => createServer(notes));
  closeHandler = () => handler.close();
  const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const connected = new Client({ name: "test-harness", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await connected.connect(transport);
  return connected;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { text: first?.text ?? "", isError: result.isError === true };
}

describe("list_notes", () => {
  test("lists every note, newest first, as tab-separated rows under a header", async () => {
    const { text } = await call("list_notes");

    expect(text.split("\n")).toEqual([
      "id\tcategory\ttitle\tmodified",
      "108\tShared\tShared checklist\t2024-10-27T03:33:20.000Z",
      "256\tOps\tRunbook draft\t2024-08-30T06:40:00.000Z",
      "42\t\tCache glossary\t2024-07-09T04:40:00.000Z",
      "17\tProjects/Alpha\t架空の設計メモ\t2024-03-09T16:00:00.000Z",
      "3\tProjects/Alpha\tKickoff memo\t2023-11-14T22:13:20.000Z",
    ]);
  });

  test("filters by category and favorite", async () => {
    const { text } = await call("list_notes", { category: "Projects/Alpha", favorite: true });

    expect(text.split("\n").slice(1)).toEqual(["3\tProjects/Alpha\tKickoff memo\t2023-11-14T22:13:20.000Z"]);
  });

  test("filters by modification time, including a note modified exactly then", async () => {
    const { text } = await call("list_notes", { modified_since: "2024-08-30T15:40:00+09:00" });

    expect(text.split("\n").slice(1)).toEqual([
      "108\tShared\tShared checklist\t2024-10-27T03:33:20.000Z",
      "256\tOps\tRunbook draft\t2024-08-30T06:40:00.000Z",
    ]);
  });

  test("treats a bare date as midnight UTC", async () => {
    const { text } = await call("list_notes", { modified_since: "2024-07-10" });

    expect(text.split("\n").slice(1)).toEqual([
      "108\tShared\tShared checklist\t2024-10-27T03:33:20.000Z",
      "256\tOps\tRunbook draft\t2024-08-30T06:40:00.000Z",
    ]);
  });

  test("limits the rows and says how many were left out", async () => {
    const { text } = await call("list_notes", { limit: 2 });

    expect(text.split("\n").slice(1)).toEqual([
      "108\tShared\tShared checklist\t2024-10-27T03:33:20.000Z",
      "256\tOps\tRunbook draft\t2024-08-30T06:40:00.000Z",
      "(3 more notes not shown)",
    ]);
  });

  test("rejects a modification time that is not ISO 8601", async () => {
    const result = await call("list_notes", { modified_since: "last week" });

    expect(result.isError).toBe(true);
  });

  test("reports an authentication failure as a tool error", async () => {
    await client.close();
    await closeHandler();
    client = await connect(new NotesClient({ ...config, password: "wrong-password" }));

    const result = await call("list_notes");

    expect(result).toEqual({
      text: "Authentication failed (401): check NC_NOTES_USER and NC_NOTES_PASSWORD.",
      isError: true,
    });
  });
});

describe("search_notes", () => {
  test("returns matching lines with merged context, ignoring case", async () => {
    const { text } = await call("search_notes", { query: "cache", category: "Projects/Alpha", context_lines: 1 });

    expect(text).toBe(
      [
        "=== id=17 [Projects/Alpha] 架空の設計メモ ===",
        "3-line 3",
        "4:line 4 cache layer",
        "5-line 5",
        "--",
        "8-line 8",
        "9:line 9 cache eviction",
        "10-line 10",
        "11:line 11 CACHE size",
        "12-line 12",
      ].join("\n"),
    );
  });

  test("lists notes whose title matches even when the content does not", async () => {
    const { text } = await call("search_notes", { query: "cache", ids_only: true });

    expect(text.split("\n")).toEqual(["17\tProjects/Alpha\t架空の設計メモ", "42\t\tCache glossary"]);
  });

  test("supports regular expressions", async () => {
    const { text } = await call("search_notes", { query: "^- (owner|budget):", regex: true, context_lines: 0 });

    expect(text).toBe(["=== id=3 [Projects/Alpha] Kickoff memo ===", "3:- owner: TBD", "--", "5:- budget: unknown"].join("\n"));
  });

  test("rejects an invalid regular expression", async () => {
    const result = await call("search_notes", { query: "(", regex: true });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Invalid regular expression/);
  });

  test("says so when nothing matches", async () => {
    expect(await call("search_notes", { query: "nonexistent-term" })).toEqual({ text: "No matches.", isError: false });
  });
});

describe("get_note", () => {
  test("returns metadata, etag and the full content", async () => {
    const { text } = await call("get_note", { id: 42 });

    expect(text).toBe(
      [
        "id: 42",
        "title: Cache glossary",
        "category: ",
        "favorite: false",
        "modified: 2024-07-09T04:40:00.000Z",
        "etag: etag-42-a",
        "readonly: false",
        "",
        "Terms only.",
      ].join("\n"),
    );
  });

  test("reports a missing note", async () => {
    expect(await call("get_note", { id: 9999 })).toEqual({ text: "Note not found (404).", isError: true });
  });

  test("returns only the requested lines", async () => {
    const { text } = await call("get_note", { id: 256, start_line: 3, end_line: 4 });

    expect(text.split("\n").slice(-4)).toEqual(["lines: 3-4 of 11", "", "## Setup", "install steps"]);
  });

  test("stops at the last line when end_line is past it", async () => {
    const { text } = await call("get_note", { id: 256, start_line: 10, end_line: 99 });

    expect(text.split("\n").slice(-4)).toEqual(["lines: 10-11 of 11", "", "## Teardown", "remove steps"]);
  });

  test("reports a start_line past the end of the note", async () => {
    expect(await call("get_note", { id: 42, start_line: 2 })).toEqual({
      text: "start_line 2 is past the end of note 42 (1 lines).",
      isError: true,
    });
  });

  test("rejects an end_line before start_line", async () => {
    expect(await call("get_note", { id: 256, start_line: 5, end_line: 4 })).toEqual({
      text: "end_line must not be less than start_line.",
      isError: true,
    });
  });
});

describe("get_note_outline", () => {
  test("lists ATX headings with line numbers, skipping fenced code and hashtags", async () => {
    const { text } = await call("get_note_outline", { id: 256 });

    expect(text.split("\n").slice(-6)).toEqual([
      "lines: 11",
      "",
      "1:# Runbook draft",
      "3:## Setup",
      "8:### Verify",
      "10:## Teardown",
    ]);
  });

  test("says so when the note has no headings", async () => {
    const { text } = await call("get_note_outline", { id: 42 });

    expect(text.split("\n").slice(-1)).toEqual(["No headings."]);
  });
});

describe("create_note", () => {
  test("creates the note and returns what the server stored", async () => {
    const { text } = await call("create_note", { title: "Draft", content: "body", category: "Inbox" });

    const created = store.notes.at(-1);
    expect(created).toMatchObject({ title: "Draft", content: "body", category: "Inbox", favorite: false });
    expect(text).toContain(`id: ${created?.id}\ntitle: Draft\ncategory: Inbox`);
  });
});

describe("edit_note", () => {
  test("replaces a unique string and keeps the rest of the content", async () => {
    const { text } = await call("edit_note", { id: 3, old_string: "owner: TBD", new_string: "owner: fixture-user" });

    expect(store.find(3)?.content).toBe(
      ["# Kickoff memo", "", "- owner: fixture-user", "- deadline: next sprint", "- budget: unknown"].join("\n"),
    );
    expect(text).toMatch(/^Replaced 1 occurrence\(s\)\.\nid: 3\n/);
  });

  test("inserts the replacement literally, without expanding $ patterns", async () => {
    await call("edit_note", { id: 42, old_string: "Terms", new_string: "$& and $1" });

    expect(store.find(42)?.content).toBe("$& and $1 only.");
  });

  test("refuses an ambiguous string unless replace_all is set", async () => {
    const refused = await call("edit_note", { id: 17, old_string: "line 1", new_string: "row 1" });
    expect(refused).toEqual({
      text: "old_string occurs 3 times in note 17. Add surrounding text to make it unique, or set replace_all.",
      isError: true,
    });

    await call("edit_note", { id: 17, old_string: "line 1", new_string: "row 1", replace_all: true });
    expect(store.find(17)?.content.split("\n").slice(9)).toEqual(["row 10", "row 11 CACHE size", "row 12"]);
  });

  test("reports a string that is not in the note", async () => {
    expect(await call("edit_note", { id: 42, old_string: "absent", new_string: "x" })).toEqual({
      text: "old_string was not found in note 42.",
      isError: true,
    });
  });

  test("does not overwrite a change made between its read and its write", async () => {
    network.use(
      http.put(/\/notes\/42$/, () => {
        const note = store.find(42)!;
        note.content = "Changed on another device.";
        store.touch(note);
        return undefined;
      }),
    );

    const result = await call("edit_note", { id: 42, old_string: "Terms", new_string: "Words" });

    expect(result).toEqual({ text: "The note was changed elsewhere since its etag was read (412).", isError: true });
    expect(store.find(42)?.content).toBe("Changed on another device.");
  });

  test("reports a read-only note", async () => {
    expect(await call("edit_note", { id: 108, old_string: "step two", new_string: "step 2" })).toEqual({
      text: "The note is read-only (403).",
      isError: true,
    });
  });
});

describe("update_note", () => {
  test("changes metadata without an etag", async () => {
    await call("update_note", { id: 42, category: "Glossary", favorite: true });

    expect(store.find(42)).toMatchObject({ category: "Glossary", favorite: true, content: "Terms only." });
  });

  test("requires an etag to replace content", async () => {
    expect(await call("update_note", { id: 42, content: "new body" })).toEqual({
      text: "etag is required when replacing content. Read it with get_note first.",
      isError: true,
    });
  });

  test("replaces content when the etag is current", async () => {
    await call("update_note", { id: 42, content: "new body", etag: "etag-42-a" });

    expect(store.find(42)?.content).toBe("new body");
  });

  test("refuses to replace content with a stale etag", async () => {
    const result = await call("update_note", { id: 42, content: "new body", etag: "etag-42-old" });

    expect(result.isError).toBe(true);
    expect(store.find(42)?.content).toBe("Terms only.");
  });

  test("refuses an update with no fields", async () => {
    expect(await call("update_note", { id: 42 })).toEqual({ text: "Nothing to update.", isError: true });
  });
});

describe("delete_note", () => {
  test("deletes the note", async () => {
    expect(await call("delete_note", { id: 17 })).toEqual({ text: "Deleted note 17.", isError: false });
    expect(store.find(17)).toBeUndefined();
  });
});

describe("add_attachment", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "nextcloud-note-mcp-test-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true });
  });

  test("uploads a local file and returns the stored path", async () => {
    const filePath = join(directory, "figure.svg");
    await writeFile(filePath, "<svg/>");

    const { text } = await call("add_attachment", { id: 42, file_path: filePath });

    expect(text).toBe("Attached as .attachments.42/figure.svg");
    expect(new TextDecoder().decode(store.findAttachment(42, ".attachments.42/figure.svg")?.data)).toBe("<svg/>");
  });

  test("reports a file that cannot be read", async () => {
    const result = await call("add_attachment", { id: 42, file_path: join(directory, "missing.png") });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Cannot read .*missing\.png: /);
  });

  test("reports a missing note", async () => {
    const filePath = join(directory, "figure.svg");
    await writeFile(filePath, "<svg/>");

    expect(await call("add_attachment", { id: 9999, file_path: filePath })).toEqual({
      text: "Note or attachment not found (404).",
      isError: true,
    });
  });
});

describe("get_attachment", () => {
  test("returns an image as image content", async () => {
    const result = await client.callTool({
      name: "get_attachment",
      arguments: { id: 3, path: ".attachments.3/diagram.png" },
    });

    expect(result.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
  });

  test("returns a text file as text", async () => {
    expect(await call("get_attachment", { id: 3, path: ".attachments.3/notes.txt" })).toEqual({
      text: "plain text",
      isError: false,
    });
  });

  test("refuses other file types", async () => {
    expect(await call("get_attachment", { id: 108, path: ".attachments.108/spec.pdf" })).toEqual({
      text: ".attachments.108/spec.pdf is application/pdf; only PNG, JPEG, GIF, WebP and text files can be returned.",
      isError: true,
    });
  });

  test("reports a missing attachment", async () => {
    expect(await call("get_attachment", { id: 3, path: ".attachments.3/absent.png" })).toEqual({
      text: "Note or attachment not found (404).",
      isError: true,
    });
  });
});

describe("delete_attachment", () => {
  test("deletes the attachment", async () => {
    expect(await call("delete_attachment", { id: 3, path: ".attachments.3/notes.txt" })).toEqual({
      text: "Deleted attachment .attachments.3/notes.txt of note 3.",
      isError: false,
    });
    expect(store.findAttachment(3, ".attachments.3/notes.txt")).toBeUndefined();
  });

  test("reports a read-only note", async () => {
    expect(await call("delete_attachment", { id: 108, path: ".attachments.108/spec.pdf" })).toEqual({
      text: "The note is read-only (403).",
      isError: true,
    });
  });
});

describe("note resources", () => {
  test("lists every note as a resource", async () => {
    const { resources } = await client.listResources();

    expect(resources).toHaveLength(5);
    expect(resources[0]).toEqual({
      uri: "notes://3",
      name: "Kickoff memo",
      title: "Kickoff memo",
      description: "Category: Projects/Alpha",
      mimeType: "text/markdown",
    });
    expect(resources[2]).toEqual({
      uri: "notes://42",
      name: "Cache glossary",
      title: "Cache glossary",
      mimeType: "text/markdown",
    });
  });

  test("reads a note's content", async () => {
    const { contents } = await client.readResource({ uri: "notes://42" });

    expect(contents).toEqual([{ uri: "notes://42", mimeType: "text/markdown", text: "Terms only." }]);
  });
});

test("returns a 400 from the server as a tool error", async () => {
  network.use(http.post(/\/notes$/, () => HttpResponse.json({}, { status: 400 })));

  expect(await call("create_note", { title: "x", content: "" })).toEqual({
    text: "Invalid request (400): check the note id, title or category.",
    isError: true,
  });
});
