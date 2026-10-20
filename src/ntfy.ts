/**
 * Built-in ntfy-compatible push server.
 *
 * otg-bot hosts its own push endpoint, so a phone running the ntfy app can
 * subscribe directly — no ntfy.sh account or third-party server needed:
 *
 *   Publish   : PUT or POST /<topic>   (body = message;
 *               Title / Priority / Tags / Click headers, X- prefixed too)
 *   Subscribe : GET /<topic>/sse       (Server-Sent Events / EventSource)
 *               GET /<topic>/json      (newline-delimited JSON stream)
 *               GET /<topic>/raw       (one raw message per line)
 *               ?poll=1                one-shot: return cached messages, then close
 *               ?since=<id|all>        replay cache from a message id
 *
 * Messages are cached in SQLite (newest 200 per topic) and replayed to new
 * subscribers. Publishing is a write, so it needs INGEST_TOKEN when set;
 * subscribing is a read and stays open.
 *
 * When NTFY_TOPIC is set, every local publish is also mirrored to that topic
 * on NTFY_URL (the external relay in ./notify.ts) — unset it to go fully local.
 *
 * Phone-app note: the ntfy Android (F-Droid) build does instant delivery over
 * a persistent connection; the Play Store build needs FCM, which this server
 * does not provide, so background delivery there may not work. iOS without an
 * upstream server falls back to slow polling. Subscribe the app to
 * http://<host>:<port>/<topic> and test what your build delivers.
 */
import { randomBytes } from "node:crypto";
import { listNtfyMessages, saveNtfyMessage, type NtfyMessage } from "./db";
import { sendNotification } from "./notify";

/** Local topic the feed watcher and /notify/test publish to. */
export const NTFY_LOCAL_TOPIC = process.env.NTFY_LOCAL_TOPIC?.trim() || "otg";

export const TOPIC_RE = /^[A-Za-z0-9_\-@.]{1,64}$/;
export const MAX_MESSAGE_BYTES = 65536;

const KEEPALIVE_MS = 30_000;

export interface PublishInput {
  message: string;
  title?: string;
  priority?: number;
  tags?: string[];
  click?: string;
}

function newId(): string {
  return randomBytes(9).toString("base64url");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Wire format shared by the JSON stream and the SSE data payload. */
export function toWire(m: NtfyMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    time: m.time,
    event: "message",
    topic: m.topic,
    message: m.message,
    priority: m.priority,
  };
  if (m.title) out.title = m.title;
  if (m.tags) out.tags = m.tags.split(",");
  if (m.click) out.click = m.click;
  return out;
}

export function parsePriority(raw: string | null | undefined): number {
  if (!raw) return 3;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  const names: Record<string, number> = { min: 1, low: 2, default: 3, high: 4, urgent: 5, max: 5 };
  return names[String(raw).toLowerCase()] ?? 3;
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 16);
}

type Format = "sse" | "json" | "raw";

interface Subscriber {
  format: Format;
  push: (chunk: string) => void;
}

const subscribers = new Map<string, Set<Subscriber>>();

function encode(format: Format, m: NtfyMessage): string {
  if (format === "json") return JSON.stringify(toWire(m)) + "\n";
  if (format === "raw") return m.message + "\n";
  return `id: ${m.id}\nevent: message\ndata: ${JSON.stringify(toWire(m))}\n\n`;
}

/**
 * Publish a message: stored in the cache, fanned out to live subscribers,
 * and mirrored to the external ntfy server when NTFY_TOPIC is set.
 * Throws on an invalid topic; never throws for relay failures.
 */
export function publishMessage(topic: string, input: PublishInput): NtfyMessage {
  if (!TOPIC_RE.test(topic)) throw new Error(`invalid topic: ${topic}`);
  const m: NtfyMessage = {
    id: newId(),
    topic,
    time: nowSec(),
    message: input.message,
    title: input.title ?? null,
    priority: Math.min(5, Math.max(1, Math.round(input.priority ?? 3))),
    tags: input.tags?.length ? input.tags.join(",") : null,
    click: input.click ?? null,
  };
  saveNtfyMessage(m);

  const subs = subscribers.get(topic);
  if (subs?.size) {
    const encoded = new Map<Format, string>();
    for (const s of [...subs]) {
      try {
        let chunk = encoded.get(s.format);
        if (!chunk) {
          chunk = encode(s.format, m);
          encoded.set(s.format, chunk);
        }
        s.push(chunk);
      } catch {
        subs.delete(s);
      }
    }
  }

  // Mirror to the external ntfy server (no-op when NTFY_TOPIC is unset).
  void sendNotification({
    title: m.title ?? undefined,
    message: m.message,
    priority: m.priority,
    tags: m.tags ? m.tags.split(",") : undefined,
    click: m.click ?? undefined,
  }).catch((err: unknown) => {
    console.error(`[ntfy] relay failed: ${(err as Error).message}`);
  });

  console.log(`[ntfy] published to local topic "${topic}"`);
  return m;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function openPayload(format: Format, topic: string): string | null {
  const obj = { id: newId(), time: nowSec(), event: "open", topic };
  if (format === "sse") return `event: open\ndata: ${JSON.stringify(obj)}\n\n`;
  if (format === "json") return JSON.stringify(obj) + "\n";
  return null; // raw has no open event
}

function keepalivePayload(format: Format, topic: string): string | null {
  if (format === "sse") return `: keepalive\n\n`;
  if (format === "json") {
    return JSON.stringify({ id: newId(), time: nowSec(), event: "keepalive", topic }) + "\n";
  }
  return null;
}

/** One-shot poll: cached messages without holding the connection open. */
function pollResponse(topic: string, format: Format, since: string | null): Response {
  const messages = listNtfyMessages(topic, since);
  if (format === "json") {
    return new Response(JSON.stringify(messages.map(toWire), null, 2) + "\n", {
      headers: { "content-type": "application/json; charset=utf-8", ...CORS },
    });
  }
  const body = messages.map((m) => encode(format, m)).join("");
  const ct = format === "sse" ? "text/event-stream" : "text/plain";
  return new Response(body, {
    headers: { "content-type": `${ct}; charset=utf-8`, ...CORS },
  });
}

/** Long-lived subscription: replay cache, then stream live messages. */
export function subscribeResponse(topic: string, format: Format, url: URL): Response {
  if (!TOPIC_RE.test(topic)) {
    return new Response(JSON.stringify({ error: "invalid topic" }) + "\n", {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", ...CORS },
    });
  }
  if (url.searchParams.get("poll") === "1") {
    return pollResponse(topic, format, url.searchParams.get("since"));
  }

  const enc = new TextEncoder();
  let sub: Subscriber | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    if (sub) {
      const set = subscribers.get(topic);
      set?.delete(sub);
      if (set && set.size === 0) subscribers.delete(topic);
      sub = null;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      const push = (chunk: string) => controller.enqueue(enc.encode(chunk));
      sub = { format, push };
      let set = subscribers.get(topic);
      if (!set) {
        set = new Set();
        subscribers.set(topic, set);
      }
      set.add(sub);

      const open = openPayload(format, topic);
      if (open) push(open);
      for (const m of listNtfyMessages(topic, url.searchParams.get("since"))) {
        push(encode(format, m));
      }
      keepalive = setInterval(() => {
        try {
          const ka = keepalivePayload(format, topic);
          if (ka) push(ka);
        } catch {
          cleanup();
        }
      }, KEEPALIVE_MS);
    },
    cancel() {
      cleanup();
    },
  });

  const ct =
    format === "sse" ? "text/event-stream" : format === "json" ? "application/x-ndjson" : "text/plain";
  return new Response(stream, {
    headers: {
      "content-type": `${ct}; charset=utf-8`,
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...CORS,
    },
  });
}
