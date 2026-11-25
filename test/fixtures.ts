import type { Note, NotesConfig } from "../src/notes-api.js";

export const config: NotesConfig = {
  url: "https://cloud.example.test/",
  user: "fixture-user",
  password: "fixture-app-password",
};

export const notes: Note[] = [
  {
    id: 3,
    etag: "etag-3-a",
    readonly: false,
    title: "Kickoff memo",
    category: "Projects/Alpha",
    favorite: true,
    modified: 1_700_000_000,
    content: ["# Kickoff memo", "", "- owner: TBD", "- deadline: next sprint", "- budget: unknown"].join("\n"),
  },
  {
    id: 17,
    etag: "etag-17-a",
    readonly: false,
    title: "架空の設計メモ",
    category: "Projects/Alpha",
    favorite: false,
    modified: 1_710_000_000,
    content: [
      "# 架空の設計メモ",
      "line 2",
      "line 3",
      "line 4 cache layer",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9 cache eviction",
      "line 10",
      "line 11 CACHE size",
      "line 12",
    ].join("\n"),
  },
  {
    id: 42,
    etag: "etag-42-a",
    readonly: false,
    title: "Cache glossary",
    category: "",
    favorite: false,
    modified: 1_720_500_000,
    content: "Terms only.",
  },
  {
    id: 256,
    etag: "etag-256-a",
    readonly: false,
    title: "Runbook draft",
    category: "Ops",
    favorite: false,
    modified: 1_725_000_000,
    content: [
      "# Runbook draft",
      "",
      "## Setup",
      "install steps",
      "```bash",
      "# not a heading",
      "```",
      "   ### Verify",
      "#hashtag-not-heading",
      "## Teardown",
      "remove steps",
    ].join("\n"),
  },
  {
    id: 108,
    etag: "etag-108-a",
    readonly: true,
    title: "Shared checklist",
    category: "Shared",
    favorite: true,
    modified: 1_730_000_000,
    content: "- [ ] step one\n- [ ] step one\n- [x] step two",
  },
];

export interface FixtureAttachment {
  noteId: number;
  path: string;
  mimeType: string;
  data: Uint8Array;
}

export const attachments: FixtureAttachment[] = [
  {
    noteId: 3,
    path: ".attachments.3/diagram.png",
    mimeType: "image/png",
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { noteId: 3, path: ".attachments.3/notes.txt", mimeType: "text/plain", data: new TextEncoder().encode("plain text") },
  { noteId: 108, path: ".attachments.108/spec.pdf", mimeType: "application/pdf", data: new Uint8Array([0x25, 0x50]) },
];
