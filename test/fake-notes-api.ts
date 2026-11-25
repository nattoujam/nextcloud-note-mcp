import { http, HttpResponse } from "msw/http";
import type { Note, NoteInput } from "../src/notes-api.js";
import { config, type FixtureAttachment } from "./fixtures.js";

const base = `${config.url.replace(/\/+$/, "")}/index.php/apps/notes/api/v1`;
const expectedAuthorization = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`;

export class FakeNotesStore {
  notes: Note[];
  attachments: FixtureAttachment[];
  private revision = 0;
  private nextId = 1000;

  constructor(initialNotes: Note[], initialAttachments: FixtureAttachment[]) {
    this.notes = structuredClone(initialNotes);
    this.attachments = structuredClone(initialAttachments);
  }

  find(id: number): Note | undefined {
    return this.notes.find((note) => note.id === id);
  }

  findAttachment(noteId: number, path: string | null): FixtureAttachment | undefined {
    return this.attachments.find((attachment) => attachment.noteId === noteId && attachment.path === path);
  }

  touch(note: Note): void {
    this.revision += 1;
    note.etag = `etag-${note.id}-r${this.revision}`;
  }

  handlers() {
    return [
      http.all(`${base}/*`, ({ request }) => {
        if (request.headers.get("Authorization") !== expectedAuthorization) {
          return HttpResponse.json({ message: "unauthorized" }, { status: 401 });
        }
        return undefined;
      }),
      http.get(`${base}/notes`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        const category = params.get("category");
        const exclude = (params.get("exclude") ?? "").split(",");
        const listed = this.notes
          .filter((note) => category === null || note.category === category)
          .map((note) =>
            Object.fromEntries(Object.entries(note).filter(([key]) => !exclude.includes(key))),
          );
        return HttpResponse.json(listed);
      }),
      http.get(`${base}/notes/:id`, ({ params }) => {
        const note = this.find(Number(params.id));
        return note ? HttpResponse.json(note) : HttpResponse.json({}, { status: 404 });
      }),
      http.post(`${base}/notes`, async ({ request }) => {
        const input = (await request.json()) as NoteInput;
        const note: Note = {
          id: this.nextId++,
          etag: "",
          readonly: false,
          title: input.title ?? "",
          content: input.content ?? "",
          category: input.category ?? "",
          favorite: input.favorite ?? false,
          modified: 1_740_000_000,
        };
        this.touch(note);
        this.notes.push(note);
        return HttpResponse.json(note);
      }),
      http.put(`${base}/notes/:id`, async ({ params, request }) => {
        const note = this.find(Number(params.id));
        if (!note) return HttpResponse.json({}, { status: 404 });
        if (note.readonly) return HttpResponse.json({}, { status: 403 });
        const ifMatch = request.headers.get("If-Match");
        if (ifMatch !== null && ifMatch !== `"${note.etag}"`) {
          return HttpResponse.json(note, { status: 412 });
        }
        Object.assign(note, (await request.json()) as NoteInput);
        this.touch(note);
        return HttpResponse.json(note);
      }),
      http.delete(`${base}/notes/:id`, ({ params }) => {
        const note = this.find(Number(params.id));
        if (!note) return HttpResponse.json({}, { status: 404 });
        this.notes = this.notes.filter((other) => other !== note);
        return HttpResponse.json({});
      }),
      http.get(`${base}/attachment/:id`, ({ params, request }) => {
        const attachment = this.findAttachment(Number(params.id), new URL(request.url).searchParams.get("path"));
        if (!attachment) return new HttpResponse(null, { status: 404 });
        return new HttpResponse(attachment.data, { headers: { "Content-Type": attachment.mimeType } });
      }),
      http.post(`${base}/attachment/:id`, async ({ params, request }) => {
        const noteId = Number(params.id);
        if (!this.find(noteId)) return HttpResponse.json({}, { status: 404 });
        const file = (await request.formData()).get("file");
        if (!(file instanceof File)) return HttpResponse.json({}, { status: 500 });
        const path = `.attachments.${noteId}/${file.name}`;
        this.attachments.push({ noteId, path, mimeType: file.type, data: new Uint8Array(await file.arrayBuffer()) });
        return HttpResponse.json({ filename: path });
      }),
      http.delete(`${base}/attachment/:id`, ({ params, request }) => {
        const note = this.find(Number(params.id));
        const attachment = this.findAttachment(Number(params.id), new URL(request.url).searchParams.get("path"));
        if (!note || !attachment) return HttpResponse.json({}, { status: 404 });
        if (note.readonly) return HttpResponse.json({}, { status: 403 });
        this.attachments = this.attachments.filter((other) => other !== attachment);
        return HttpResponse.json({});
      }),
    ];
  }
}
