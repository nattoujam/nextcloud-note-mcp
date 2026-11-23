import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { NotesClient } from "../src/notes-api.js";
import { createServer } from "../src/server.js";
import { FakeNotesStore } from "./fake-notes-api.js";
import { config, notes as fixtureNotes } from "./fixtures.js";

const network = setupServer();
let store: FakeNotesStore;
let client: Client;
let closeHandler: () => Promise<void>;

beforeAll(() => network.listen({ onUnhandledFrame: "error" }));
afterAll(() => network.close());

beforeEach(async () => {
  store = new FakeNotesStore(fixtureNotes);
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
  test("lists every note as tab-separated rows under a header", async () => {
    const { text } = await call("list_notes");

    expect(text.split("\n")).toEqual([
      "id\tcategory\ttitle\tmodified",
      "3\tProjects/Alpha\tKickoff memo\t2023-11-14T22:13:20.000Z",
      "17\tProjects/Alpha\t架空の設計メモ\t2024-03-09T16:00:00.000Z",
      "42\t\tCache glossary\t2024-07-09T04:40:00.000Z",
      "108\tShared\tShared checklist\t2024-10-27T03:33:20.000Z",
    ]);
  });

  test("filters by category and favorite", async () => {
    const { text } = await call("list_notes", { category: "Projects/Alpha", favorite: true });

    expect(text.split("\n").slice(1)).toEqual(["3\tProjects/Alpha\tKickoff memo\t2023-11-14T22:13:20.000Z"]);
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

test("returns a 400 from the server as a tool error", async () => {
  network.use(http.post(/\/notes$/, () => HttpResponse.json({}, { status: 400 })));

  expect(await call("create_note", { title: "x", content: "" })).toEqual({
    text: "Invalid request (400): check the note id, title or category.",
    isError: true,
  });
});
