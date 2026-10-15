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

  search: db.prepare(`
    SELECT d.id, d.url, d.title, d.site_name, d.status, d.word_count,
           d.created_at,
           snippet(documents_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet,
           bm25(documents_fts) AS rank
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.rowid
    WHERE documents_fts MATCH ?
    ORDER BY rank
    LIMIT ? OFFSET ?
  `),
};

export function listDocuments(
  status: string | null,
  limit: number,
  offset: number,
): DocumentRow[] {
  const where = status ? "WHERE status = ?" : "";
  const sql = `
    SELECT id, url, status, title, description, site_name, author,
           word_count, reading_minutes, content_type, fetched_at,
           created_at, substr(content, 1, 240) AS excerpt
    FROM documents ${where}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `;
  const params = status ? [status, limit, offset] : [limit, offset];
  return db.prepare(sql).all(...params) as DocumentRow[];
}

export function countDocuments(status: string | null): number {
  const row = status
    ? db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = ?").get(status)
    : db.prepare("SELECT COUNT(*) AS n FROM documents").get();
  return Number((row as { n: number }).n);
}
