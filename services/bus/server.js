import path from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "../../shared/ids.js";
import { HttpError, listen } from "../../shared/http.js";

const PORT = Number(process.env.PORT || 4200);
const DB_PATH = process.env.DB_PATH || path.resolve("data", "bus.sqlite");
mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE,
    stream TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

listen(PORT, [
  {
    method: "GET",
    path: "/health",
    handler: () => ({ body: { ok: true, service: "bus", events: db.prepare("SELECT COUNT(*) AS n FROM events").get().n } }),
  },
  {
    method: "POST",
    path: "/streams/:name/events",
    handler: ({ params, body }) => {
      if (!body?.id || !body?.type) throw new HttpError(400, "El evento necesita id y type.", "event");
      const existing = db.prepare("SELECT seq, id, type FROM events WHERE id = ?").get(body.id);
      if (existing) return { body: { seq: existing.seq, id: existing.id, duplicate: true } };
      db.prepare("INSERT INTO events (id, stream, type, data, created_at) VALUES (?, ?, ?, ?, ?)").run(
        body.id,
        params.name,
        body.type,
        JSON.stringify(body.data || {}),
        nowIso(),
      );
      const saved = db.prepare("SELECT seq FROM events WHERE id = ?").get(body.id);
      return { status: 201, body: { seq: saved.seq, id: body.id, duplicate: false } };
    },
  },
  {
    method: "GET",
    path: "/streams/:name/events",
    handler: ({ params, url }) => {
      const after = Number(url.searchParams.get("after") || 0);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
      const rows = db.prepare("SELECT seq, id, type, data, created_at FROM events WHERE stream = ? AND seq > ? ORDER BY seq LIMIT ?").all(params.name, after, limit);
      return {
        body: {
          events: rows.map((row) => ({ seq: row.seq, id: row.id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at })),
        },
      };
    },
  },
]);

console.log(`[bus] en :${PORT}`);
