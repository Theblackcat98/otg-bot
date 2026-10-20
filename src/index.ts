/**
 * OTG-BOT — URL keeper pipeline (v1.3.0).
 *
 *   Ingestion API  : save URLs, import bookmarks, RSS/Atom feed watcher
 *   Scraper worker : fetches pages, extracts clean text + metadata (Cheerio)
 *   Embedded store : bun:sqlite — content, snapshots, tags, notes, FTS5 index
 *   Web UI         : served at /
 *   Push server   : ntfy-compatible publish/subscribe (SSE, JSON, raw streams)
 *
 * Start: bun run dist/index.js   (dev: bun run src/index.ts)
 */
import { timingSafeEqual } from "node:crypto";
import * as cheerio from "cheerio";
import {
  addNote,
  addTag,
  countDocuments,
  DATA_DIR,
  db,
  deleteDocument,
  deleteFeed,
  deleteNote,
  getFeed,
  getSettings,
  getSnapshot,
  getTags,
  hasSnapshot,
  insertFeed,
  insertIgnoreByUrl,
  listDocuments,
  listFeeds,
  listNotes,
  searchDocuments,
  setFeedEnabled,
  setSetting,
  setTags,
  SETTING_KEYS,
  stmts,
} from "./db";
import { checkFeedNow, startFeeds, stopFeeds } from "./feeds";
import {
  MAX_MESSAGE_BYTES,
  NTFY_LOCAL_TOPIC,
  parsePriority,
  parseTags,
  publishMessage,
  subscribeResponse,
  TOPIC_RE,
} from "./ntfy";
import UI_HTML from "./ui.html" with { type: "text" };
import { kick, startWorker, stopWorker } from "./worker";

// Botkeep exposes the allocated public port as SERVER_PORT; PORT is a generic fallback.
const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3000);
const INGEST_TOKEN = process.env.INGEST_TOKEN || null;
const VERSION = "1.3.0";
const MAX_BATCH = 25;
const MAX_IMPORT = 10_000;
const SKIP_FOLDERS = new Set([
  "bookmarks bar",
  "bookmarks toolbar",
  "bookmarks menu",
  "other bookmarks",
  "mobile bookmarks",
]);

const startedAt = Date.now();

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** All writes require INGEST_TOKEN when it is set. Reads stay open. */
function authorized(req: Request, url: URL): boolean {
  if (!INGEST_TOKEN) return true;
  const header = req.headers.get("authorization");
  if (header && safeEqual(header, `Bearer ${INGEST_TOKEN}`)) return true;
  const token = url.searchParams.get("token");
  return !!token && safeEqual(token, INGEST_TOKEN);
}

/** Validate and normalize a submitted URL. Returns null when invalid. */
function normalizeUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function splitTags(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  if (typeof input === "string") return input.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const data = await req.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "expected a JSON object");
  }
  return data as Record<string, unknown>;
}

// ---------------------------------------------------------------- ingestion

/** Create documents for new URLs and merge tags into all of them. */
function saveUrls(
  urls: string[],
  tags: string[],
): { queued: { id: number; url: string }[]; duplicates: string[] } {
  const queued: { id: number; url: string }[] = [];
  const duplicates: string[] = [];
  for (const url of urls) {
    const isNew = insertIgnoreByUrl(url);
    const row = stmts.getByUrl.get(url) as { id: number; url: string } | null;
    if (!row) continue;
    for (const tag of tags) addTag(row.id, tag);
    if (isNew) queued.push({ id: row.id, url: row.url });
    else duplicates.push(url);
  }
  if (queued.length > 0) kick();
  return { queued, duplicates };
}

async function handleIngest(req: Request, url: URL): Promise<Response> {
  let raw: unknown[];
  let tags: string[];

  if (req.method === "GET") {
    raw = [url.searchParams.get("url") ?? url.searchParams.get("u")];
    tags = splitTags(url.searchParams.get("tags"));
  } else {
    const body = await req.text();
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) {
        raw = parsed;
        tags = [];
      } else {
        raw = Array.isArray(parsed?.urls) ? parsed.urls : [parsed?.url];
        tags = splitTags(parsed?.tags);
      }
    } else if (ct.includes("x-www-form-urlencoded")) {
      const params = new URLSearchParams(body);
      raw = [...params.getAll("url"), ...params.getAll("urls").flatMap((s) => s.split(/\s+/))];
      tags = splitTags(params.get("tags"));
    } else {
      raw = body.split(/\s+/); // text/plain share-sheet style
      tags = splitTags(url.searchParams.get("tags"));
    }
  }

  const invalid: string[] = [];
  const candidates: string[] = [];
  for (const item of raw) {
    const normalized = normalizeUrl(item);
    if (normalized) candidates.push(normalized);
    else if (item != null && String(item) !== "") invalid.push(String(item));
  }
  if (candidates.length === 0 && invalid.length === 0) {
    throw new HttpError(400, "no URL provided");
  }

  const unique = [...new Set(candidates)];
  const batch = unique.slice(0, MAX_BATCH);
  const outcome = saveUrls(batch, tags);

  return json(
    {
      accepted: outcome.queued.length,
      queued: outcome.queued,
      duplicates: outcome.duplicates,
      invalid,
      tags,
      overflowSkipped: unique.length - batch.length,
    },
    202,
  );
}

// ---------------------------------------------------------------- bookmarks import (#3)

/** Parse a browser bookmarks HTML export (Netscape format). Folder names become tags. */
export function parseBookmarks(html: string): { url: string; tags: string[] }[] {
  const $ = cheerio.load(html);
  // Exporters differ: the folder H3 may precede its DL, sit inside the preceding DT,
  // or sit inside the DT that wraps the DL (unclosed <DT> tags nest the DL).
  type Wrapped = ReturnType<typeof $>;
  const folderName = ($dl: Wrapped): string => {
    const candidates = [
      $dl.prev("h3"),
      $dl.prevAll("dt").first().children("h3"),
      $dl.parent("dt").children("h3"),
    ];
    for (const c of candidates) {
      const name = c.first().text().trim().toLowerCase();
      if (name) return name;
    }
    return "";
  };

  const out: { url: string; tags: string[] }[] = [];
  $("a[href]").each((_, el) => {
    const tags: string[] = [];
    $(el)
      .parents("dl")
      .each((_, dl) => {
        const folder = folderName($(dl));
        if (folder && !SKIP_FOLDERS.has(folder)) tags.push(folder);
      });
    out.push({ url: $(el).attr("href") ?? "", tags: [...new Set(tags)] });
  });
  return out;
}

async function handleImport(req: Request): Promise<Response> {
  const entries = parseBookmarks(await req.text());
  const seen = new Set<string>();
  let imported = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const entry of entries.slice(0, MAX_IMPORT)) {
    const url = normalizeUrl(entry.url);
    if (!url) {
      invalid++;
      continue;
    }
    if (seen.has(url)) {
      duplicates++;
      continue;
    }
    seen.add(url);
    const isNew = insertIgnoreByUrl(url);
    const row = stmts.getByUrl.get(url) as { id: number } | null;
    if (row) {
      for (const tag of entry.tags) addTag(row.id, tag);
    }
    if (isNew) imported++;
    else duplicates++;
  }
  if (imported > 0) kick();

  return json({
    found: entries.length,
    imported,
    duplicates,
    invalid,
    truncated: entries.length > MAX_IMPORT,
  });
}

// ---------------------------------------------------------------- documents

function documentDetail(id: number): Record<string, unknown> | null {
  const row = stmts.getById.get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    ...row,
    raw_metadata: row.raw_metadata ? JSON.parse(row.raw_metadata as string) : null,
    tags: getTags(id),
    notes: listNotes(id),
    has_snapshot: hasSnapshot(id),
  };
}

/** #1 raw snapshot. Served sandboxed: scripts and same-origin access are blocked. */
function serveSnapshot(id: number): Response {
  const doc = stmts.getById.get(id) as { url: string } | null;
  const snap = getSnapshot(id);
  if (!doc || !snap) return json({ error: "snapshot not found" }, 404);

  const headers: Record<string, string> = {
    "content-security-policy": "sandbox",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=300",
    ...CORS,
  };

  if (!/html/i.test(snap.content_type ?? "")) {
    return new Response(snap.html, {
      headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Base tag keeps relative links, images and stylesheets pointing at the original site.
  const base = `<base href="${escapeAttr(doc.url)}">`;
  const html = /<head[^>]*>/i.test(snap.html)
    ? snap.html.replace(/<head([^>]*)>/i, (_, attrs: string) => `<head${attrs}>${base}`)
    : base + snap.html;
  return new Response(html, {
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------- settings (#8, UI-managed)

function validateSettings(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!SETTING_KEYS.includes(key)) throw new HttpError(400, `unknown setting: ${key}`);
    if (key === "feed_poll_minutes") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 1440) {
        throw new HttpError(400, "feed_poll_minutes must be an integer from 1 to 1440");
      }
      out[key] = String(n);
    } else {
      const flag =
        raw === true || raw === 1 || raw === "1" ? "1" : raw === false || raw === 0 || raw === "0" ? "0" : null;
      if (flag === null) throw new HttpError(400, `${key} must be true or false`);
      out[key] = flag;
    }
  }
  return out;
}

// ---------------------------------------------------------------- routes

const RE = {
  doc: /^\/documents\/(\d+)$/,
  docRaw: /^\/documents\/(\d+)\/raw$/,
  docTags: /^\/documents\/(\d+)\/tags$/,
  docNotes: /^\/documents\/(\d+)\/notes$/,
  docNote: /^\/documents\/(\d+)\/notes\/(\d+)$/,
  feed: /^\/feeds\/(\d+)$/,
  feedCheck: /^\/feeds\/(\d+)\/check$/,
  notifyTest: /^\/notify\/test$/,
  topicSub: /^\/([A-Za-z0-9_\-@.]{1,64})\/(sse|json|raw)$/,
  topicPub: /^\/([A-Za-z0-9_\-@.]{1,64})$/,
};

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const isWrite = method !== "GET" && method !== "HEAD";
  if (isWrite && !authorized(req, url)) return json({ error: "unauthorized" }, 401);

  // ---- UI and service info
  if (path === "/" && method === "GET") {
    return new Response(UI_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "content-security-policy":
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
      },
    });
  }

  if (path === "/api" && method === "GET") {
    const counts = stmts.statusCounts.all() as { status: string; n: number }[];
    return json({
      service: "otg-bot",
      version: VERSION,
      description: "URL keeper: ingestion API → scraper worker → embedded SQLite store",
      endpoints: {
        "GET    /health": "liveness probe",
        "POST   /ingest": "save URL(s): {url} | {urls:[…]} | url=… form | plain text; optional tags",
        "GET    /ingest?url=…&tags=…": "bookmarklet / share-sheet submission",
        "POST   /import/bookmarks": "browser bookmarks HTML export (folders become tags)",
        "GET    /documents?limit=&offset=&status=&tag=": "list documents",
        "GET    /documents/:id": "full document: content, metadata, tags, notes",
        "GET    /documents/:id/raw": "stored HTML snapshot (sandboxed)",
        "POST   /documents/:id/tags": "replace tags: {tags:[…]}",
        "POST   /documents/:id/notes": "add note: {note}",
        "DELETE /documents/:id/notes/:noteId": "delete a note",
        "DELETE /documents/:id": "delete a document",
        "GET    /search?q=&tag=&limit=&offset=": "full-text search (FTS5)",
        "GET    /feeds": "list RSS/Atom feeds",
        "POST   /feeds": "add feed: {url}",
        "PATCH  /feeds/:id": "enable/disable: {enabled}",
        "POST   /feeds/:id/check": "check a feed now",
        "DELETE /feeds/:id": "remove a feed",
        "GET    /settings": "runtime settings",
        "PUT    /settings": "update settings (feed_poll_minutes, feeds_enabled, snapshots)",
        "GET    /queue": "worker queue statistics",
        "PUT    /<topic>": "publish a push message (body = message; Title/Priority/Tags/Click headers)",
        "POST   /<topic>": "publish a push message (same as PUT)",
        "GET    /<topic>/sse": "subscribe: Server-Sent Events stream",
        "GET    /<topic>/json": "subscribe: newline-delimited JSON stream (?poll=1 one-shot)",
        "GET    /<topic>/raw": "subscribe: raw message stream",
        "POST   /notify/test": "publish a test message to the local push topic",
      },
      documents: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      writes: INGEST_TOKEN ? "token required" : "open",
    });
  }

  if (path === "/health" && method === "GET") {
    return json({ ok: true, version: VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  }

  // ---- ingestion and import
  if (path === "/ingest" && (method === "POST" || method === "GET")) {
    return handleIngest(req, url);
  }

  if (path === "/import/bookmarks" && method === "POST") {
    return handleImport(req);
  }

  // ---- documents
  if (path === "/documents" && method === "GET") {
    const limit = clamp(Number(url.searchParams.get("limit") ?? 25) || 25, 1, 100);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    const status = url.searchParams.get("status") || null;
    const tag = url.searchParams.get("tag")?.trim().toLowerCase() || null;
    return json({
      total: countDocuments(status, tag),
      limit,
      offset,
      documents: listDocuments(status, tag, limit, offset),
    });
  }

  let m = RE.doc.exec(path);
  if (m) {
    const id = Number(m[1]);
    if (method === "GET") {
      const detail = documentDetail(id);
      return detail ? json(detail) : json({ error: "document not found" }, 404);
    }
    if (method === "DELETE") {
      return deleteDocument(id) ? json({ deleted: id }) : json({ error: "document not found" }, 404);
    }
    return json({ error: "method not allowed" }, 405);
  }

  m = RE.docRaw.exec(path);
  if (m && method === "GET") return serveSnapshot(Number(m[1]));

  m = RE.docTags.exec(path);
  if (m && method === "POST") {
    const id = Number(m[1]);
    if (!stmts.getById.get(id)) return json({ error: "document not found" }, 404);
    const body = await readJson(req);
    return json({ tags: setTags(id, splitTags(body.tags)) });
  }

  m = RE.docNotes.exec(path);
  if (m && method === "POST") {
    const id = Number(m[1]);
    if (!stmts.getById.get(id)) return json({ error: "document not found" }, 404);
    const body = await readJson(req);
    const note = String(body.note ?? "").trim();
    if (!note) throw new HttpError(400, "note is required");
    return json(addNote(id, note), 201);
  }

  m = RE.docNote.exec(path);
  if (m && method === "DELETE") {
    const ok = deleteNote(Number(m[1]), Number(m[2]));
    return ok ? json({ deleted: Number(m[2]) }) : json({ error: "note not found" }, 404);
  }

  // ---- search
  if (path === "/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const tokens = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (tokens.length === 0) return json({ error: "missing search query (?q=)" }, 400);
    const match = tokens.map((t) => `"${t}"*`).join(" AND ");
    const tag = url.searchParams.get("tag")?.trim().toLowerCase() || null;
    const limit = clamp(Number(url.searchParams.get("limit") ?? 20) || 20, 1, 50);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    try {
      const results = searchDocuments(match, tag, limit, offset);
      return json({ query: q, tag, limit, offset, results });
    } catch {
      return json({ error: "search failed", query: q }, 400);
    }
  }

  // ---- feeds (#8)
  if (path === "/feeds" && method === "GET") {
    return json(listFeeds().map((f) => ({ ...f, enabled: !!f.enabled })));
  }

  if (path === "/feeds" && method === "POST") {
    const body = await readJson(req);
    const feedUrl = normalizeUrl(body.url);
    if (!feedUrl) throw new HttpError(400, "url must be a valid http(s) address");
    const feed = insertFeed(feedUrl);
    if (!feed) throw new HttpError(500, "could not store feed");
    void checkFeedNow(feed.id).catch(() => {});
    return json({ ...feed, enabled: !!feed.enabled }, 201);
  }

  m = RE.feedCheck.exec(path);
  if (m && method === "POST") {
    const result = await checkFeedNow(Number(m[1]));
    return result ? json(result) : json({ error: "feed not found" }, 404);
  }

  m = RE.feed.exec(path);
  if (m) {
    const id = Number(m[1]);
    const feed = getFeed(id);
    if (!feed) return json({ error: "feed not found" }, 404);
    if (method === "PATCH") {
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
      setFeedEnabled(id, body.enabled);
      return json({ ...getFeed(id), enabled: body.enabled });
    }
    if (method === "DELETE") {
      deleteFeed(id);
      return json({ deleted: id });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // ---- settings
  if (path === "/settings" && method === "GET") {
    return json(getSettings());
  }

  if (path === "/settings" && method === "PUT") {
    const updates = validateSettings(await readJson(req));
    for (const [key, value] of Object.entries(updates)) setSetting(key, value);
    return json(getSettings());
  }

  // ---- queue
  if (path === "/queue" && method === "GET") {
    const counts = stmts.statusCounts.all() as { status: string; n: number }[];
    return json({
      byStatus: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      recentErrors: stmts.recentErrors.all(),
    });
  }

  // ---- ntfy-compatible push server (checked after all specific routes)
  if (RE.notifyTest.exec(path) && method === "POST") {
    const msg = publishMessage(NTFY_LOCAL_TOPIC, {
      title: "OTG-BOT",
      message: "Test notification — the push server is wired up.",
      tags: ["white_check_mark"],
    });
    return json({ sent: true, topic: NTFY_LOCAL_TOPIC, id: msg.id });
  }

  m = RE.topicSub.exec(path);
  if (m && method === "GET") {
    return subscribeResponse(m[1], m[2] as "sse" | "json" | "raw", url);
  }

  m = RE.topicPub.exec(path);
  if (m && (method === "PUT" || method === "POST")) {
    const topic = m[1];
    if (!TOPIC_RE.test(topic)) return json({ error: "invalid topic" }, 404);
    const body = await req.text();
    const message =
      body || url.searchParams.get("message") || req.headers.get("x-message") || "";
    if (!message) throw new HttpError(400, "message body is required");
    if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
      throw new HttpError(413, `message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }
    const msg = publishMessage(topic, {
      message,
      title:
        req.headers.get("title") ??
        req.headers.get("x-title") ??
        url.searchParams.get("title") ??
        undefined,
      priority: parsePriority(req.headers.get("priority") ?? req.headers.get("x-priority")),
      tags: parseTags(req.headers.get("tags") ?? req.headers.get("x-tags")),
      click:
        req.headers.get("click") ??
        req.headers.get("x-click") ??
        url.searchParams.get("click") ??
        undefined,
    });
    return json({ id: msg.id, time: msg.time, topic: msg.topic });
  }

  return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------- boot

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch: (req) =>
    route(req).catch((err: unknown) => {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof SyntaxError) return json({ error: "malformed request body" }, 400);
      console.error("[http] unhandled error:", (err as Error).message);
      return json({ error: "internal server error" }, 500);
    }),
});

startWorker();
startFeeds();

console.log(`[otg-bot] v${VERSION} listening on http://0.0.0.0:${PORT} — store: ${DATA_DIR}`);

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[otg-bot] ${signal} received, shutting down…`);
  stopWorker();
  stopFeeds();
  server.stop(false);
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
