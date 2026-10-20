/**
 * Feed watcher (#8) — polls RSS/Atom feeds and ingests new item links.
 * Feed list, interval and on/off switch are runtime settings edited in the
 * web UI (stored in the settings table), not environment variables.
 */
import * as cheerio from "cheerio";
import {
  addTag,
  enabledFeeds,
  getFeed,
  getSetting,
  insertIgnoreByUrl,
  markFeedChecked,
  stmts,
  type FeedRow,
} from "./db";
import { kick } from "./worker";
import { NTFY_LOCAL_TOPIC, publishMessage } from "./ntfy";

const FETCH_TIMEOUT_MS = 20_000;
const TICK_MS = 60_000;
const USER_AGENT = "Mozilla/5.0 (compatible; OTGBot/1.0; +https://botkeep.cloud)";
const MAX_ITEMS_PER_POLL = 50;

let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let lastPollAt = 0;

function pollIntervalMinutes(): number {
  const n = Number(getSetting("feed_poll_minutes"));
  return Number.isFinite(n) ? Math.min(1440, Math.max(1, Math.round(n))) : 15;
}

function normalizeUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Extract item links (+ optional titles) from RSS 2.0 or Atom XML. */
export function parseFeedXml(xml: string): { title: string | null; links: string[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const title =
    $("rss > channel > title").first().text().trim() ||
    $("feed > title").first().text().trim() ||
    null;

  const links: string[] = [];
  const push = (raw: string | undefined | null) => {
    if (!raw) return;
    const href = normalizeUrl(raw);
    if (href && !links.includes(href) && links.length < MAX_ITEMS_PER_POLL) links.push(href);
  };

  $("item").each((_, item) => {
    const $item = $(item);
    const guid = $item.children("guid").first().text().trim();
    push($item.children("link").first().text().trim() || $item.attr("rdf:about") || guid);
  });

  $("entry").each((_, entry) => {
    const $entry = $(entry);
    const alt = $entry
      .children("link")
      .filter((_, l) => ($(l).attr("rel") ?? "alternate") === "alternate")
      .first()
      .attr("href");
    push(alt ?? $entry.children("link").first().attr("href") ?? $entry.children("id").first().text());
  });

  return { title, links };
}

/** Poll one feed. Ingests item links; new documents get the feed title as a tag. */
export async function pollFeed(feed: FeedRow): Promise<{ ingested: number; status: string }> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "*/*" };
  if (feed.etag) headers["if-none-match"] = feed.etag;
  if (feed.last_modified) headers["if-modified-since"] = feed.last_modified;

  try {
    const res = await fetch(feed.url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 304) {
      markFeedChecked(feed.id, "not-modified");
      return { ingested: 0, status: "not-modified" };
    }
    if (!res.ok) {
      const msg = `HTTP ${res.status} ${res.statusText}`;
      markFeedChecked(feed.id, "error", { error: msg });
      return { ingested: 0, status: "error" };
    }

    const xml = await res.text();
    const { title, links } = parseFeedXml(xml);

    let ingested = 0;
    for (const link of links) {
      const isNew = insertIgnoreByUrl(link);
      if (!isNew) continue;
      const row = stmts.getByUrl.get(link) as { id: number } | undefined;
      if (row) {
        addTag(row.id, (title ?? new URL(link).hostname).slice(0, 64));
        ingested++;
      }
    }
    if (ingested > 0) kick();

    markFeedChecked(feed.id, "ok", {
      title,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      ingested,
    });
    return { ingested, status: "ok" };
  } catch (err) {
    const msg = ((err as Error).message ?? String(err)).slice(0, 300);
    markFeedChecked(feed.id, "error", { error: msg });
    return { ingested: 0, status: "error" };
  }
}

async function pollAllFeeds(): Promise<void> {
  polling = true;
  try {
    const feeds = enabledFeeds();
    let total = 0;
    const perFeed: { name: string; ingested: number }[] = [];
    for (const feed of feeds) {
      const r = await pollFeed(feed);
      total += r.ingested;
      if (r.ingested > 0) {
        perFeed.push({ name: (feed.title ?? feed.url).slice(0, 60), ingested: r.ingested });
      }
    }
    if (feeds.length > 0) {
      console.log(`[feeds] checked ${feeds.length} feed(s), ${total} new item(s)`);
    }
    if (total > 0) {
      const lines = perFeed.map((f) => `• ${f.name}: ${f.ingested}`);
      publishMessage(NTFY_LOCAL_TOPIC, {
        title: "OTG-BOT",
        message: `${total} new item(s)\n${lines.join("\n")}`.slice(0, 1000),
        tags: ["newspaper"],
      });
    }
  } finally {
    polling = false;
    lastPollAt = Date.now();
  }
}

async function tick(): Promise<void> {
  if (polling) return;
  if (getSetting("feeds_enabled") === "0") return;
  const due = Date.now() - lastPollAt >= pollIntervalMinutes() * 60_000;
  if (!due) return;
  await pollAllFeeds();
}

export function startFeeds(): void {
  timer = setInterval(() => void tick(), TICK_MS);
  const enabled = getSetting("feeds_enabled") !== "0";
  console.log(`[feeds] watcher ${enabled ? "enabled" : "disabled"} (interval: ${pollIntervalMinutes()} min)`);
}

export function stopFeeds(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function checkFeedNow(id: number): Promise<{ ingested: number; status: string } | null> {
  const feed = getFeed(id);
  if (!feed) return null;
  return pollFeed(feed);
}
