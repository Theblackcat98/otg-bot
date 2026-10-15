/**
 * OTG-BOT — URL keeper pipeline.
 *
 *   Ingestion API : HTTP endpoints receiving URLs from bookmarks / share sheets
 *   Scraper worker: fetches pages, extracts clean text + metadata (Cheerio)
 *   Embedded store: bun:sqlite — cleaned content, raw metadata, FTS5 index
 *
 * Start: bun run src/index.ts
 */
import { timingSafeEqual } from "node:crypto";
import {
  countDocuments,
  DATA_DIR,
  db,
  listDocuments,
  removeDocumentFromIndex,
  stmts,
} from "./db";
import { startWorker, stopWorker, kick } from "./worker";

// Botkeep exposes the allocated public port as SERVER_PORT; PORT is a generic fallback.
const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3000);
const INGEST_TOKEN = process.env.INGEST_TOKEN || null;
const MAX_BATCH = 25;

const startedAt = Date.now();

// ---------------------------------------------------------------- helpers

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
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

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

interface IngestResult {
  accepted: number;
  queued: { id: number; url: string }[];
  duplicates: string[];
  invalid: string[];
}

async function handleIngest(req: Request, url: URL): Promise<Response> {
  if (!authorized(req, url)) {
    return json({ error: "unauthorized" }, 401);
  }

  // Collect candidate URLs from JSON body, form body, plain text or query.
  let raw: unknown[] = [];
  if (req.method === "GET") {
    raw = [url.searchParams.get("url") ?? url.searchParams.get("u")];
  } else {
    const body = await req.text();
    const ct = req.headers.get("content-type") ?? "";
    try {
      if (ct.includes("application/json")) {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) raw = parsed;
        else if (Array.isArray(parsed?.urls)) raw = parsed.urls;
        else raw = [parsed?.url];
      } else if (ct.includes("x-www-form-urlencoded")) {
        const params = new URLSearchParams(body);
        raw = [...params.getAll("url"), ...params.getAll("urls")];
      } else {
        raw = body.split(/\s+/); // text/plain share-sheet style
      }
    } catch {
      return json({ error: "malformed request body" }, 400);
    }
  }

  const invalid: string[] = [];
  const candidates: string[] = [];
  for (const item of raw) {
    const normalized = normalizeUrl(item);
    if (normalized) candidates.push(normalized);
    else if (item != null && item !== "") invalid.push(String(item));
  }
  const unique = [...new Set(candidates)].slice(0, MAX_BATCH);
  const overflow = candidates.length - unique.length;

  // Insert new URLs, keep existing ones untouched.
  const knownBefore = new Set<string>();
  for (const c of unique) {
    if (stmts.getByUrl.get(c)) knownBefore.add(c);
  }
  for (const c of unique) stmts.insertIgnore.run(c);

  const queued: { id: number; url: string }[] = [];
  const duplicates: string[] = [];
  for (const c of unique) {
    const row = stmts.getByUrl.get(c) as { id: number; url: string } | null;
    if (!row) continue;
    if (knownBefore.has(c)) duplicates.push(c);
    else queued.push(row);
  }

  if (queued.length > 0) kick();

  const result: IngestResult & { overflowSkipped: number } = {
    accepted: queued.length,
    queued,
    duplicates,
    invalid,
    overflowSkipped: Math.max(0, overflow),
  };
  return json(result, 202);
}

// ---------------------------------------------------------------- routes

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/health" && method === "GET") {
    return json({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  }

  if (path === "/" && method === "GET") {
    const counts = stmts.statusCounts.all() as { status: string; n: number }[];
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
    return json({
      service: "otg-bot",
      version: "1.0.0",
      description: "URL keeper pipeline: ingestion API → scraper worker → embedded SQLite store",
      endpoints: {
        "GET  /health": "liveness probe",
        "POST /ingest": "submit URL(s): {url} | {urls:[...]} | url=… form | plain text",
        "GET  /ingest?url=…": "bookmarklet / share-sheet friendly submission",
        "GET  /documents?limit=&offset=&status=": "list documents (excerpt view)",
        "GET  /documents/:id": "full document incl. cleaned content + raw metadata",
        "DELETE /documents/:id": "remove a document",
        "GET  /search?q=…": "full-text search (FTS5)",
        "GET  /queue": "worker queue statistics",
      },
      documents: byStatus,
    });
  }

  if (path === "/ingest" && (method === "POST" || method === "GET")) {
    return handleIngest(req, url);
  }

  if (path === "/documents" && method === "GET") {
    const limit = clamp(Number(url.searchParams.get("limit") ?? 25) || 25, 1, 100);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    const status = url.searchParams.get("status");
    return json({
      total: countDocuments(status),
      limit,
      offset,
      documents: listDocuments(status, limit, offset),
    });
  }

  const docMatch = /^\/documents\/(\d+)$/.exec(path);
  if (docMatch) {
    const id = Number(docMatch[1]);
    const row = stmts.getById.get(id) as Record<string, unknown> | undefined;
    if (!row) return json({ error: "document not found" }, 404);

    if (method === "GET") {
      return json({ ...row, raw_metadata: row.raw_metadata ? JSON.parse(row.raw_metadata as string) : null });
    }
    if (method === "DELETE") {
      if (!authorized(req, url)) return json({ error: "unauthorized" }, 401);
      removeDocumentFromIndex(id);
      stmts.deleteById.run(id);
      return json({ deleted: id });
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (path === "/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const tokens = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (tokens.length === 0) return json({ error: "missing search query (?q=)" }, 400);
    const match = tokens.map((t) => `"${t}"*`).join(" AND ");
    const limit = clamp(Number(url.searchParams.get("limit") ?? 20) || 20, 1, 50);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    try {
      const results = stmts.search.all(match, limit, offset);
      return json({ query: q, limit, offset, results });
    } catch {
      return json({ error: "search failed", query: q }, 400);
    }
  }

  if (path === "/queue" && method === "GET") {
    const counts = stmts.statusCounts.all() as { status: string; n: number }[];
    return json({
      byStatus: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      recentErrors: stmts.recentErrors.all(),
    });
  }

  return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------- boot

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch: (req) => route(req).catch((err) => {
    console.error("[http] unhandled error:", (err as Error).message);
    return json({ error: "internal server error" }, 500);
  }),
});

startWorker();

console.log(
  `[otg-bot] ingestion API listening on http://0.0.0.0:${PORT} — store: ${DATA_DIR}`,
);

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[otg-bot] ${signal} received, shutting down…`);
  stopWorker();
  server.stop(false);
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
