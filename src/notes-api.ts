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

  private async request<T>(
    method: string,
    path: string,
    options: { body?: NoteInput; etag?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.authorization,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.etag !== undefined) headers["If-Match"] = `"${options.etag}"`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      throw new NotesApiError(describeStatus(response.status), response.status);
    }
    return (await response.json()) as T;
  }
}

function describeStatus(status: number): string {
  switch (status) {
    case 400:
      return "Invalid request (400): check the note id, title or category.";
    case 401:
      return "Authentication failed (401): check NC_NOTES_USER and NC_NOTES_PASSWORD.";
    case 403:
      return "The note is read-only (403).";
    case 404:
      return "Note not found (404).";
    case 412:
      return "The note was changed elsewhere since its etag was read (412).";
    case 423:
      return "The note file is locked (423); try again later.";
    case 507:
      return "Insufficient storage on the Nextcloud server (507).";
    default:
      return `Nextcloud Notes API returned HTTP ${status}.`;
  }
}
