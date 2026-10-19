/**
 * ntfy.sh push notifications — optional, configured by environment.
 *
 *   NTFY_TOPIC  topic to publish to (unset = notifications disabled)
 *   NTFY_URL    ntfy server, default https://ntfy.sh (self-host or paid tiers)
 *   NTFY_TOKEN  bearer token when the server requires auth
 *
 * Publish is a plain HTTP POST: the message is the body, Title / Priority /
 * Tags are headers (see https://docs.ntfy.sh/publish/).
 *
 * Note: topics on the public ntfy.sh are readable by anyone who guesses the
 * name — use a hard-to-guess topic (e.g. `otg-<random>`) or a private server.
 */
const NTFY_URL = (process.env.NTFY_URL ?? "https://ntfy.sh").replace(/\/+$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC?.trim() || null;
const NTFY_TOKEN = process.env.NTFY_TOKEN?.trim() || null;
const NTFY_TIMEOUT_MS = 10_000;

export interface Notification {
  title?: string;
  message: string;
  /** 1 (min) .. 5 (urgent); default 3. */
  priority?: number;
  /** ntfy emoji aliases, e.g. ["newspaper", "warning"]. */
  tags?: string[];
  /** URL opened when the notification is tapped. */
  click?: string;
}

export interface NotifyResult {
  sent: boolean;
  reason?: string;
}

export function ntfyEnabled(): boolean {
  return NTFY_TOPIC !== null;
}

/** Publish one notification. Throws when the server rejects the request. */
export async function sendNotification(n: Notification): Promise<NotifyResult> {
  if (!NTFY_TOPIC) return { sent: false, reason: "ntfy not configured (NTFY_TOPIC unset)" };

  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    Title: n.title ?? "OTG-BOT",
    Priority: String(Math.min(5, Math.max(1, Math.round(n.priority ?? 3)))),
  };
  if (n.tags?.length) headers.Tags = n.tags.join(",");
  if (n.click) headers.Click = n.click;
  if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;

  const res = await fetch(`${NTFY_URL}/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: "POST",
    headers,
    body: n.message,
    signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`ntfy publish failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`[ntfy] published to ${NTFY_TOPIC}`);
  return { sent: true };
}

/** Fire-and-forget: errors are logged, never thrown into the caller. */
export function notify(n: Notification): void {
  void sendNotification(n).catch((err: unknown) => {
    console.error(`[ntfy] ${(err as Error).message}`);
  });
}
