/**
 * Embedded store — bun:sqlite (SQLite with WAL + FTS5).
 *
 * Holds cleaned document content, raw metadata and the search index
 * in a single embedded database file.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(import.meta.dir, "..", "data");

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "otg.sqlite"));

db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA synchronous = NORMAL;");
db.run("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT    NOT NULL UNIQUE,
  status          TEXT    NOT NULL DEFAULT 'queued', -- queued | processing | ready | error
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  title           TEXT,
  description     TEXT,
  author          TEXT,
  site_name       TEXT,
  lang            TEXT,
  canonical_url   TEXT,
  image           TEXT,
  content         TEXT,              -- cleaned article text
  word_count      INTEGER,
  reading_minutes INTEGER,
  raw_metadata    TEXT,              -- JSON: meta tags, link tags, JSON-LD, response info
  content_type    TEXT,
  fetched_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Search index over title, description and cleaned content.
-- rowid is kept in sync with documents.id.
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title,
  description,
  content,
  url UNINDEXED
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status, id);

-- #1 raw page snapshots (full HTML kept alongside cleaned content)
CREATE TABLE IF NOT EXISTS snapshots (
  document_id  INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  content_type TEXT,
  html         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- #10 tagging
CREATE TABLE IF NOT EXISTS tags (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (document_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

-- #10 notes
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  note        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- #8 RSS/Atom feeds
CREATE TABLE IF NOT EXISTS feeds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT    NOT NULL UNIQUE,
  title           TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  etag            TEXT,
  last_modified   TEXT,
  last_checked_at TEXT,
  last_status     TEXT, -- ok | not-modified | error
  last_error      TEXT,
  items_ingested  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- editable runtime settings (managed in the web UI)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ntfy-compatible push server: cached messages per topic
CREATE TABLE IF NOT EXISTS ntfy_messages (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT, -- total publish order
  id       TEXT NOT NULL UNIQUE,              -- public message id
  topic    TEXT NOT NULL,
  time     INTEGER NOT NULL, -- unix seconds
  message  TEXT NOT NULL,
  title    TEXT,
  priority INTEGER NOT NULL DEFAULT 3,
  tags     TEXT,             -- comma-separated emoji aliases
  click    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ntfy_topic_seq ON ntfy_messages(topic, seq);
`);

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export interface DocumentRow {
  id: number;
  url: string;
  status: string;
  attempts: number;
  last_error: string | null;
  title: string | null;
  description: string | null;
  author: string | null;
  site_name: string | null;
  lang: string | null;
  canonical_url: string | null;
  image: string | null;
  content: string | null;
  word_count: number | null;
  reading_minutes: number | null;
  raw_metadata: string | null;
  content_type: string | null;
  fetched_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Keep the FTS row for a document up to date. */
export function indexDocument(d: {
  id: number;
  url: string;
  title: string | null;
  description: string | null;
  content: string | null;
}): void {
  db.run("DELETE FROM documents_fts WHERE rowid = ?", [d.id]);
  db.run(
    "INSERT INTO documents_fts (rowid, title, description, content, url) VALUES (?, ?, ?, ?, ?)",
    [d.id, d.title ?? "", d.description ?? "", d.content ?? "", d.url],
  );
}

export function removeDocumentFromIndex(id: number): void {
  db.run("DELETE FROM documents_fts WHERE rowid = ?", [id]);
}

/** Delete a document plus its snapshot, tags and notes (FTS too). */
export function deleteDocument(id: number): boolean {
  const changes = db.run("DELETE FROM documents WHERE id = ?", [id]).changes;
  if (changes === 0) return false;
  removeDocumentFromIndex(id);
  db.run("DELETE FROM snapshots WHERE document_id = ?", [id]);
  db.run("DELETE FROM tags WHERE document_id = ?", [id]);
  db.run("DELETE FROM notes WHERE document_id = ?", [id]);
  return true;
}

export const stmts = {
  insertIgnore: db.prepare("INSERT OR IGNORE INTO documents (url) VALUES (?)"),
  getByUrl: db.prepare("SELECT id, url, status FROM documents WHERE url = ?"),
  getById: db.prepare("SELECT * FROM documents WHERE id = ?"),
  deleteById: db.prepare("DELETE FROM documents WHERE id = ?"),

  claimNext: db.prepare(`
    UPDATE documents
    SET status = 'processing', attempts = attempts + 1, updated_at = ${NOW}
    WHERE id = (
      SELECT id FROM documents
      WHERE status = 'queued' AND attempts < ?
      ORDER BY id LIMIT 1
    )
    RETURNING *
  `),

  markReady: db.prepare(`
    UPDATE documents SET
      status = 'ready', title = ?, description = ?, author = ?,
      site_name = ?, lang = ?, canonical_url = ?, image = ?,
      content = ?, word_count = ?, reading_minutes = ?,
      raw_metadata = ?, content_type = ?, last_error = NULL,
      fetched_at = ${NOW}, updated_at = ${NOW}
    WHERE id = ?
  `),

  markError: db.prepare(`
    UPDATE documents
    SET status = ?, last_error = ?, updated_at = ${NOW}
    WHERE id = ?
  `),

  resetProcessing: db.prepare(
    "UPDATE documents SET status = 'queued' WHERE status = 'processing'",
  ),

  statusCounts: db.prepare(
    "SELECT status, COUNT(*) AS n FROM documents GROUP BY status",
  ),

  recentErrors: db.prepare(`
    SELECT id, url, attempts, last_error, updated_at
    FROM documents WHERE status = 'error'
    ORDER BY updated_at DESC LIMIT 10
  `),
};

/** Insert a URL if unseen. Returns true when a new document was created. */
export function insertIgnoreByUrl(url: string): boolean {
  return db.run("INSERT OR IGNORE INTO documents (url) VALUES (?)", [url]).changes > 0;
}

export function hasSnapshot(documentId: number): boolean {
  return !!db.prepare("SELECT 1 FROM snapshots WHERE document_id = ?").get(documentId);
}

/** Full-text search, optionally restricted to one tag. */
export function searchDocuments(
  match: string,
  tag: string | null,
  limit: number,
  offset: number,
): Record<string, unknown>[] {
  const tagClause = tag ? "AND d.id IN (SELECT document_id FROM tags WHERE tag = ?)" : "";
  const params = tag ? [match, tag, limit, offset] : [match, limit, offset];
  const rows = db
    .prepare(
      `SELECT d.id, d.url, d.title, d.site_name, d.status, d.word_count, d.created_at,
              snippet(documents_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet,
              bm25(documents_fts) AS rank,
              (SELECT group_concat(t.tag, ',') FROM tags t WHERE t.document_id = d.id) AS tags
       FROM documents_fts
       JOIN documents d ON d.id = documents_fts.rowid
       WHERE documents_fts MATCH ? ${tagClause}
       ORDER BY rank LIMIT ? OFFSET ?`,
    )
    .all(...params) as Record<string, unknown>[];
  for (const r of rows) r.tags = r.tags ? String(r.tags).split(",") : [];
  return rows;
}

export function listDocuments(
  status: string | null,
  tag: string | null,
  limit: number,
  offset: number,
): Record<string, unknown>[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push("d.status = ?");
    params.push(status);
  }
  if (tag) {
    where.push("EXISTS (SELECT 1 FROM tags ft WHERE ft.document_id = d.id AND ft.tag = ?)");
    params.push(tag);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT d.id, d.url, d.status, d.title, d.description, d.site_name, d.author,
              d.word_count, d.reading_minutes, d.content_type, d.fetched_at,
              d.created_at, substr(d.content, 1, 240) AS excerpt,
              (SELECT group_concat(t.tag, ',') FROM tags t WHERE t.document_id = d.id) AS tags
       FROM documents d ${whereSql}
       ORDER BY d.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];
  for (const r of rows) r.tags = r.tags ? String(r.tags).split(",") : [];
  return rows;
}

export function countDocuments(status: string | null, tag: string | null): number {
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (tag) {
    where.push("id IN (SELECT document_id FROM tags WHERE tag = ?)");
    params.push(tag);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const row = db.prepare(`SELECT COUNT(*) AS n FROM documents ${whereSql}`).get(...params);
  return Number((row as { n: number }).n);
}

// ---------------------------------------------------------------- snapshots (#1)

export function saveSnapshot(documentId: number, html: string, contentType: string): void {
  db.run(
    `INSERT INTO snapshots (document_id, content_type, html, bytes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       content_type = excluded.content_type, html = excluded.html,
       bytes = excluded.bytes, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [documentId, contentType, html, Buffer.byteLength(html)],
  );
}

export function getSnapshot(documentId: number): { html: string; content_type: string | null } | null {
  return (db
    .prepare("SELECT html, content_type FROM snapshots WHERE document_id = ?")
    .get(documentId) as { html: string; content_type: string | null } | undefined) ?? null;
}

// ---------------------------------------------------------------- tags (#10)

export function setTags(documentId: number, tags: string[]): string[] {
  const clean = [
    ...new Set(
      tags
        .map((t) => String(t).trim().toLowerCase().slice(0, 64))
        .filter((t) => t.length > 0 && t.length <= 64),
    ),
  ].slice(0, 32);
  db.run("DELETE FROM tags WHERE document_id = ?", [documentId]);
  for (const t of clean) {
    db.run("INSERT OR IGNORE INTO tags (document_id, tag) VALUES (?, ?)", [documentId, t]);
  }
  return clean;
}

export function addTag(documentId: number, tag: string): void {
  db.run("INSERT OR IGNORE INTO tags (document_id, tag) VALUES (?, ?)", [
    documentId,
    tag.trim().toLowerCase().slice(0, 64),
  ]);
}

export function getTags(documentId: number): string[] {
  return (
    db.prepare("SELECT tag FROM tags WHERE document_id = ? ORDER BY tag").all(documentId) as {
      tag: string;
    }[]
  ).map((r) => r.tag);
}

// ---------------------------------------------------------------- notes (#10)

export function addNote(documentId: number, note: string): { id: number; note: string; created_at: string } {
  const r = db
    .prepare("INSERT INTO notes (document_id, note) VALUES (?, ?) RETURNING id, note, created_at")
    .get(documentId, note.trim().slice(0, 8000)) as {
    id: number;
    note: string;
    created_at: string;
  };
  return r;
}

export function listNotes(documentId: number): { id: number; note: string; created_at: string }[] {
  return db
    .prepare("SELECT id, note, created_at FROM notes WHERE document_id = ? ORDER BY id")
    .all(documentId) as { id: number; note: string; created_at: string }[];
}

export function deleteNote(documentId: number, noteId: number): boolean {
  return db.run("DELETE FROM notes WHERE id = ? AND document_id = ?", [noteId, documentId]).changes > 0;
}

// ---------------------------------------------------------------- feeds (#8)

export interface FeedRow {
  id: number;
  url: string;
  title: string | null;
  enabled: number;
  etag: string | null;
  last_modified: string | null;
  last_checked_at: string | null;
  last_status: string | null;
  last_error: string | null;
  items_ingested: number;
  created_at: string;
}

export function insertFeed(url: string): FeedRow | null {
  db.run("INSERT OR IGNORE INTO feeds (url) VALUES (?)", [url]);
  return (db.prepare("SELECT * FROM feeds WHERE url = ?").get(url) as FeedRow | undefined) ?? null;
}

export function listFeeds(): FeedRow[] {
  return db.prepare("SELECT * FROM feeds ORDER BY id").all() as FeedRow[];
}

export function getFeed(id: number): FeedRow | null {
  return (db.prepare("SELECT * FROM feeds WHERE id = ?").get(id) as FeedRow | undefined) ?? null;
}

export function enabledFeeds(): FeedRow[] {
  return db.prepare("SELECT * FROM feeds WHERE enabled = 1 ORDER BY id").all() as FeedRow[];
}

export function setFeedEnabled(id: number, enabled: boolean): void {
  db.run("UPDATE feeds SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
}

export function deleteFeed(id: number): boolean {
  return db.run("DELETE FROM feeds WHERE id = ?", [id]).changes > 0;
}

export function markFeedChecked(
  id: number,
  status: "ok" | "not-modified" | "error",
  opts: { title?: string | null; etag?: string | null; lastModified?: string | null; error?: string | null; ingested?: number } = {},
): void {
  db.run(
    `UPDATE feeds SET
       last_status = ?, last_error = ?, last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       title = COALESCE(?, title), etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
       items_ingested = items_ingested + ?
     WHERE id = ?`,
    [status, opts.error ?? null, opts.title ?? null, opts.etag ?? null, opts.lastModified ?? null, opts.ingested ?? 0, id],
  );
}

// ---------------------------------------------------------------- settings (UI-managed)

const SETTING_DEFAULTS: Record<string, string> = {
  feed_poll_minutes: "15",
  feeds_enabled: "1",
  snapshots: "1",
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

export function getSetting(key: string): string {
  if (!(key in SETTING_DEFAULTS)) throw new Error(`unknown setting: ${key}`);
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? SETTING_DEFAULTS[key];
}

export function setSetting(key: string, value: string): void {
  if (!(key in SETTING_DEFAULTS)) throw new Error(`unknown setting: ${key}`);
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export function getSettings(): Record<string, string> {
  const out: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const row of db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
    if (row.key in out) out[row.key] = row.value;
  }
  return out;
}

// ---------------------------------------------------------------- ntfy push server

export interface NtfyMessage {
  id: string;
  topic: string;
  time: number;
  message: string;
  title: string | null;
  priority: number;
  tags: string | null;
  click: string | null;
}

/** Keep the newest N messages per topic; the cache replays on subscribe. */
const NTFY_CACHE_PER_TOPIC = 200;

export function saveNtfyMessage(m: NtfyMessage): void {
  db.run(
    `INSERT INTO ntfy_messages (id, topic, time, message, title, priority, tags, click)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.topic, m.time, m.message, m.title, m.priority, m.tags, m.click],
  );
  db.run(
    `DELETE FROM ntfy_messages WHERE topic = ? AND seq NOT IN (
       SELECT seq FROM ntfy_messages WHERE topic = ? ORDER BY seq DESC LIMIT ?
     )`,
    [m.topic, m.topic, NTFY_CACHE_PER_TOPIC],
  );
}

/** Cached messages for a topic, oldest first. `sinceId` skips up to and including it. */
export function listNtfyMessages(topic: string, sinceId?: string | null): NtfyMessage[] {
  let rows: NtfyMessage[];
  if (sinceId && sinceId !== "all") {
    const anchor = db
      .prepare("SELECT seq FROM ntfy_messages WHERE id = ? AND topic = ?")
      .get(sinceId, topic) as { seq: number } | undefined;
    rows = (anchor
      ? db
          .prepare(
            "SELECT id, topic, time, message, title, priority, tags, click FROM ntfy_messages WHERE topic = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
          )
          .all(topic, anchor.seq, NTFY_CACHE_PER_TOPIC)
      : []) as NtfyMessage[];
  } else {
    rows = db
      .prepare(
        "SELECT id, topic, time, message, title, priority, tags, click FROM ntfy_messages WHERE topic = ? ORDER BY seq ASC LIMIT ?",
      )
      .all(topic, NTFY_CACHE_PER_TOPIC) as NtfyMessage[];
  }
  return rows;
}
