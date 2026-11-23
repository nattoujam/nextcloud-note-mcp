import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { NotesClient } from "./notes-api.js";
import { createServer } from "./server.js";

const required = ["NC_NOTES_URL", "NC_NOTES_USER", "NC_NOTES_PASSWORD"] as const;
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const notes = new NotesClient({
  url: process.env.NC_NOTES_URL!,
  user: process.env.NC_NOTES_USER!,
  password: process.env.NC_NOTES_PASSWORD!,
});

const handle = serveStdio(() => createServer(notes));
process.on("SIGINT", () => {
  void handle.close();
});
