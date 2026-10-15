/**
 * Scraper worker — claims queued URLs from the embedded store, fetches and
 * extracts them, and writes cleaned content + metadata back.
 */
import {
  db,
  getSetting,
  indexDocument,
  saveSnapshot,
  stmts,
  type DocumentRow,
} from "./db";
import { fetchAndExtract } from "./scraper";

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 4));
const POLL_MS = Math.max(250, Number(process.env.POLL_MS ?? 2000));
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.FETCH_TIMEOUT_MS ?? 20_000));
const MAX_BYTES = Math.max(64 * 1024, Number(process.env.MAX_BYTES ?? 5_000_000));

let inFlight = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** On boot, re-queue jobs that were mid-flight when the process died. */
export function recoverInterrupted(): void {
  const r = stmts.resetProcessing.run();
  if (r.changes > 0) {
    console.log(`[worker] re-queued ${r.changes} interrupted document(s)`);
  }
}

function claimNext(): DocumentRow | null {
  return (stmts.claimNext.get(MAX_ATTEMPTS) as DocumentRow | undefined) ?? null;
}

const snapshotsForcedOff = process.env.SNAPSHOTS === "0";

async function processOne(doc: DocumentRow): Promise<void> {
  try {
    const ex = await fetchAndExtract(doc.url, FETCH_TIMEOUT_MS, MAX_BYTES);
    stmts.markReady.run(
      ex.title,
      ex.description,
      ex.author,
      ex.siteName,
      ex.lang,
      ex.canonicalUrl,
      ex.image,
      ex.content,
      ex.wordCount,
      ex.readingMinutes,
      JSON.stringify(ex.rawMetadata),
      ex.contentType,
      doc.id,
    );
    indexDocument({
      id: doc.id,
      url: doc.url,
      title: ex.title,
      description: ex.description,
      content: ex.content,
    });
    if (!snapshotsForcedOff && getSetting("snapshots") !== "0") {
      saveSnapshot(doc.id, ex.html, ex.contentType);
    }
    console.log(`[worker] #${doc.id} ready — ${doc.url} (${ex.wordCount} words)`);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const failed = doc.attempts >= MAX_ATTEMPTS;
    stmts.markError.run(failed ? "error" : "queued", message.slice(0, 500), doc.id);
    console.log(
      `[worker] #${doc.id} attempt ${doc.attempts}/${MAX_ATTEMPTS} failed: ${message}`,
    );
  }
}

async function tick(): Promise<void> {
  while (inFlight < CONCURRENCY) {
    const doc = claimNext();
    if (!doc) break;
    inFlight++;
    void processOne(doc).finally(() => {
      inFlight--;
      void tick(); // pick up the next job as soon as one finishes
    });
  }
}

/** Nudge the worker (called right after ingestion). */
export function kick(): void {
  void tick();
}

export function startWorker(): void {
  recoverInterrupted();
  timer = setInterval(() => void tick(), POLL_MS);
  console.log(
    `[worker] started (concurrency=${CONCURRENCY}, poll=${POLL_MS}ms, timeout=${FETCH_TIMEOUT_MS}ms, cap=${MAX_BYTES}B)`,
  );
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
