/**
 * Scraper worker logic — fetches a page and extracts clean text + metadata
 * with Cheerio.
 */
import * as cheerio from "cheerio";

const USER_AGENT =
  process.env.USER_AGENT ??
  "Mozilla/5.0 (compatible; OTGBot/1.0; +https://botkeep.cloud)";

const MAX_CONTENT_CHARS = 400_000;

export interface Extracted {
  title: string | null;
  description: string | null;
  author: string | null;
  siteName: string | null;
  lang: string | null;
  canonicalUrl: string | null;
  image: string | null;
  content: string;
  html: string; // raw page snapshot
  wordCount: number;
  readingMinutes: number;
  contentType: string;
  rawMetadata: Record<string, unknown>;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

function absolute(base: string, href?: string | null): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function decodeBody(buf: Uint8Array, contentTypeHeader: string | null): string {
  let charset =
    /charset\s*=\s*"?([\w-]+)"?/i.exec(contentTypeHeader ?? "")?.[1] ?? null;
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.subarray(0, 2048));
    charset =
      /<meta[^>]+charset\s*=\s*"?([\w-]+)"?/i.exec(head)?.[1] ??
      /<meta[^>]+content\s*=\s*"[^"]*charset=([\w-]+)"/i.exec(head)?.[1] ??
      null;
  }
  let label = (charset ?? "utf-8").toLowerCase();
  if (label === "utf8") label = "utf-8";
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function pickAuthor(jsonld: unknown[]): string | null {
  for (const item of jsonld) {
    const nodes = Array.isArray(item) ? item : [item];
    for (const node of nodes) {
      const raw = (node as Record<string, unknown>)?.author;
      const first = Array.isArray(raw) ? raw[0] : raw;
      const name =
        typeof first === "string"
          ? first
          : (first as Record<string, unknown> | undefined)?.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  }
  return null;
}

/** Fetch a URL (size-capped stream) and extract clean text + metadata. */
export async function fetchAndExtract(
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<Extracted> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "accept-language": "en,*;q=0.5",
    },
  }).catch((err: unknown) => {
    throw new FetchError(`fetch failed: ${(err as Error).message}`);
  });

  if (!res.ok) {
    res.body?.cancel();
    throw new FetchError(`HTTP ${res.status} ${res.statusText}`, res.status);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
    res.body?.cancel();
    throw new FetchError(`unsupported content-type: ${contentType || "unknown"}`, res.status);
  }

  // Stream the body with a hard size cap.
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
  }
  const html = decodeBody(concat(chunks, total), contentType);

  const $ = cheerio.load(html);

  // ---- raw metadata (kept verbatim in the store) ----
  const metas: Record<string, string> = {};
  $("meta").each((_, el) => {
    const key =
      $(el).attr("name") ?? $(el).attr("property") ?? $(el).attr("itemprop");
    const value = $(el).attr("content");
    if (key && value && !(key in metas)) metas[key] = value;
  });
  const linkRels: Record<string, string> = {};
  $("link[rel]").each((_, el) => {
    const rel = $(el).attr("rel")?.toLowerCase().split(/\s+/)[0];
    const href = $(el).attr("href");
    if (rel && href && !(rel in linkRels)) linkRels[rel] = href;
  });
  const jsonld: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      jsonld.push(JSON.parse($(el).text()));
    } catch {
      /* malformed JSON-LD is ignored */
    }
  });

  // ---- cleaned text ----
  $(
    "script, style, noscript, template, svg, iframe, frame, object, embed, form, button, " +
      "nav, header, footer, aside, " +
      "[role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary'], " +
      "[aria-hidden='true'], [hidden]",
  ).remove();

  const root =
    $("article").first().length ||
    $("main").first().length ||
    $("[role='main']").first().length
      ? $("article").first().length
        ? $("article").first()
        : $("main").first().length
          ? $("main").first()
          : $("[role='main']").first()
      : $("body");

  $("br").replaceWith("\n");
  $("p, div, section, article, li, tr, dt, dd, h1, h2, h3, h4, h5, h6, " +
    "blockquote, pre, figcaption, td, th, caption, label, summary").append("\n");

  let text = root.text() || $("body").text() || "";
  text = text
    .replace(/\r/g, "")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CONTENT_CHARS);

  const title =
    metas["og:title"] ??
    metas["twitter:title"] ??
    ($("title").first().text().trim() || null) ??
    ($("h1").first().text().trim() || null);

  const description =
    metas["og:description"] ??
    metas["twitter:description"] ??
    metas["description"] ??
    null;

  const author = metas["author"] ?? metas["article:author"] ?? pickAuthor(jsonld);

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return {
    title,
    description,
    author,
    siteName: metas["og:site_name"] ?? new URL(url).hostname,
    lang: $("html").attr("lang") ?? null,
    canonicalUrl: absolute(url, linkRels["canonical"] ?? metas["og:url"]),
    image: absolute(url, metas["og:image"] ?? metas["twitter:image"]),
    content: text,
    html: html.slice(0, 5_000_000),
    wordCount,
    readingMinutes: Math.max(1, Math.ceil(wordCount / 200)),
    contentType,
    rawMetadata: {
      metas,
      links: linkRels,
      jsonld,
      response: {
        finalUrl: res.url,
        status: res.status,
        bytesFetched: total,
        truncated: total > maxBytes,
        fetchedWith: USER_AGENT,
      },
    },
  };
}
