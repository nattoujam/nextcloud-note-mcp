export interface Note {
  id: number;
  etag: string;
  readonly: boolean;
  content: string;
  title: string;
  category: string;
  favorite: boolean;
  modified: number;
}

export type NoteSummary = Omit<Note, "content">;

export interface NoteInput {
  title?: string;
  content?: string;
  category?: string;
  favorite?: boolean;
}

export interface NotesConfig {
  url: string;
  user: string;
  password: string;
}

export class NotesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NotesApiError";
  }
}

export class NotesClient {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(config: NotesConfig) {
    this.baseUrl = `${config.url.replace(/\/+$/, "")}/index.php/apps/notes/api/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`;
  }

  listNotes(options: { category?: string } = {}): Promise<NoteSummary[]> {
    const query = new URLSearchParams({ exclude: "content" });
    if (options.category !== undefined) query.set("category", options.category);
    return this.request("GET", `/notes?${query}`);
  }

  listNotesWithContent(): Promise<Note[]> {
    return this.request("GET", "/notes");
  }

  getNote(id: number): Promise<Note> {
    return this.request("GET", `/notes/${id}`);
  }

  createNote(input: NoteInput): Promise<Note> {
    return this.request("POST", "/notes", { body: input });
  }

  updateNote(id: number, input: NoteInput, etag?: string): Promise<Note> {
    return this.request("PUT", `/notes/${id}`, { body: input, etag });
  }

  async deleteNote(id: number): Promise<void> {
    await this.request("DELETE", `/notes/${id}`);
  }

  async getAttachment(id: number, path: string): Promise<Attachment> {
    const response = await this.send("GET", `/attachment/${id}?${new URLSearchParams({ path })}`, {
      target: "attachment",
    });
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("Content-Type")?.split(";")[0]?.trim() || "application/octet-stream",
    };
  }

  async addAttachment(id: number, file: Blob, fileName: string): Promise<string> {
    const form = new FormData();
    form.append("file", file, fileName);
    const response = await this.send("POST", `/attachment/${id}`, { body: form, target: "attachment" });
    return ((await response.json()) as { filename: string }).filename;
  }

  async deleteAttachment(id: number, path: string): Promise<void> {
    await this.send("DELETE", `/attachment/${id}?${new URLSearchParams({ path })}`, { target: "attachment" });
  }

  private async request<T>(method: string, path: string, options: { body?: NoteInput; etag?: string } = {}): Promise<T> {
    const response = await this.send(method, path, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      etag: options.etag,
      target: "note",
    });
    return (await response.json()) as T;
  }

  private async send(
    method: string,
    path: string,
    options: { body?: string | FormData; etag?: string; target: RequestTarget },
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: this.authorization };
    if (options.target === "note") headers["Accept"] = "application/json";
    if (typeof options.body === "string") headers["Content-Type"] = "application/json";
    if (options.etag !== undefined) headers["If-Match"] = `"${options.etag}"`;

    const response = await fetch(`${this.baseUrl}${path}`, { method, headers, body: options.body });
    if (!response.ok) {
      throw new NotesApiError(describeStatus(response.status, options.target), response.status);
    }
    return response;
  }
}

export interface Attachment {
  data: Uint8Array;
  mimeType: string;
}

type RequestTarget = "note" | "attachment";

function describeStatus(status: number, target: RequestTarget): string {
  switch (status) {
    case 400:
      return target === "note"
        ? "Invalid request (400): check the note id, title or category."
        : "Invalid attachment path, or the Notes app is too old for attachments (400).";
    case 401:
      return "Authentication failed (401): check NC_NOTES_USER and NC_NOTES_PASSWORD.";
    case 403:
      return "The note is read-only (403).";
    case 404:
      return target === "note" ? "Note not found (404)." : "Note or attachment not found (404).";
    case 405:
      return "The installed Notes app does not support this attachment operation (405).";
    case 412:
      return "The note was changed elsewhere since its etag was read (412).";
    case 423:
      return "The note file is locked (423); try again later.";
    case 500:
      if (target === "attachment") return "Nextcloud could not store the attachment (500).";
      break;
    case 507:
      return "Insufficient storage on the Nextcloud server (507).";
  }
  return `Nextcloud Notes API returned HTTP ${status}.`;
}
