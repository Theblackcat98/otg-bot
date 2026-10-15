# OTG-BOT — Usage docs

A URL keeper. Send it links from bookmarks, share sheets, or scripts; a
background worker fetches each page, extracts clean text and metadata, and
stores everything in an embedded SQLite database you can search.

- **Deployed at:** `http://node4.botkeep.cloud:37112` (Botkeep server *OTG-BOT*)
- **Local dev:** `bun run src/index.ts` (listens on `PORT`, default 3000)

> The Botkeep port allocation does not include TLS. Traffic to the deployed
> instance is plain HTTP — do not send secrets through it, or set an
> `INGEST_TOKEN` (see [Security](#security)).

---

## 1. Save a URL

All of these do the same thing — the endpoint accepts JSON, form data, plain
text, and query parameters:

```sh
# JSON, single URL
curl -X POST http://node4.botkeep.cloud:37112/ingest \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article"}'

# JSON, batch (max 25 per request)
curl -X POST http://node4.botkeep.cloud:37112/ingest \
  -H 'content-type: application/json' \
  -d '{"urls":["https://a.example/one","https://b.example/two"]}'

# Plain text — handy for share sheets and shell pipelines
curl -X POST http://node4.botkeep.cloud:37112/ingest \
  -H 'content-type: text/plain' \
  -d 'https://example.com/article'

# Form encoded
curl -X POST http://node4.botkeep.cloud:37112/ingest -d 'url=https://example.com/article'

# GET — simplest client (bookmarklets, RSS rules, cron one-liners)
curl 'http://node4.botkeep.cloud:37112/ingest?url=https://example.com/article'
```

Response — `202 Accepted`:

```json
{
  "accepted": 1,
  "queued":   [{ "id": 1, "url": "https://example.com/article", "status": "queued" }],
  "duplicates": [],
  "invalid":    [],
  "overflowSkipped": 0
}
```

- `queued` — new URLs, now waiting for the scraper worker.
- `duplicates` — URLs already in the store; they are never re-scraped.
- `invalid` — rejected input (must be a valid `http://` / `https://` URL).
- `overflowSkipped` — URLs beyond the 25-per-request cap.

### Bookmarklet

Create a bookmark with this as the URL, then click it on any page to keep it:

```js
javascript:location.href='http://node4.botkeep.cloud:37112/ingest?url='+encodeURIComponent(location.href)
```

You will land on a small JSON response; the page is already saved and will be
scraped within seconds.

### Share sheets

Anything that can POST or open a URL can submit: HTTP Shortcuts, Tasker,
iOS Shortcuts ("Get contents of URL" with the page URL as text), or a plain
`curl` in a script. Plain-text bodies may contain one URL or many
(whitespace/newline separated).

### Re-scraping a URL

Ingesting an existing URL is a no-op (`duplicates`). To refresh a page, delete
it first, then ingest it again:

```sh
curl -X DELETE http://node4.botkeep.cloud:37112/documents/42
```

---

## 2. What happens after saving

Each document moves through a lifecycle handled by the scraper worker:

```
queued ──▶ processing ──▶ ready
    ▲            │
    └── retry ◀──┴──▶ error   (after MAX_ATTEMPTS, default 3)
```

- The worker fetches the page (20 s timeout, 5 MB body cap), removes
  boilerplate (nav, scripts, ads containers), and extracts title, description,
  author, canonical URL, preview image, and the clean article text.
- Crash-safe: documents left in `processing` by a restart are re-queued
  automatically.
- A URL that permanently fails (HTTP 404, timeouts, unsupported content type)
  ends in `error` with the reason stored. Check `/queue`.

---

## 3. Read documents

```sh
# List (newest first, excerpt view — no full content)
curl 'http://node4.botkeep.cloud:37112/documents?limit=10&offset=0'

# Filter by status: queued | processing | ready | error
curl 'http://node4.botkeep.cloud:37112/documents?status=error'

# One document, full detail: cleaned content + raw metadata
curl http://node4.botkeep.cloud:37112/documents/42

# Remove a document (and its search index entry)
curl -X DELETE http://node4.botkeep.cloud:37112/documents/42
```

List item fields:

| Field | Meaning |
| --- | --- |
| `id` | Document id (use it in `/documents/:id`, `DELETE`) |
| `url`, `status` | Source URL and lifecycle state |
| `title`, `description`, `author`, `site_name` | Extracted metadata |
| `word_count`, `reading_minutes` | From the cleaned text |
| `excerpt` | First ~240 characters of cleaned content |
| `created_at`, `fetched_at` | Ingested / scraped timestamps |

Full document adds: `content` (cleaned text), `raw_metadata` (all meta tags,
link rels, JSON-LD, response info: final URL, status, bytes fetched,
truncated flag), `canonical_url`, `image`, `lang`, `content_type`, `attempts`,
`last_error`.

---

## 4. Search

```sh
curl 'http://node4.botkeep.cloud:37112/search?q=sqlite'
curl 'http://node4.botkeep.cloud:37112/search?q=type+checks&limit=5'
```

- Full-text search over title, description, and cleaned content (SQLite FTS5).
- The query is tokenized; each token matches as a **prefix** (`type` also
  matches *types*, *typescript*), tokens combine with **AND** (all must match).
- Results are ranked by relevance (`rank`, lower is better) and include a
  highlighted `snippet` with `<mark>` around matches.
- Parameters: `q` (required), `limit` (max 50, default 20), `offset`.

---

## 5. Monitor

```sh
# Queue statistics + last 10 errors with reasons
curl http://node4.botkeep.cloud:37112/queue

# Liveness probe
curl http://node4.botkeep.cloud:37112/health

# Endpoint map + document counts
curl http://node4.botkeep.cloud:37112/
```

`/queue` example:

```json
{
  "byStatus": { "ready": 2, "error": 1 },
  "recentErrors": [
    { "id": 1, "url": "https://gone.example/", "attempts": 3,
      "last_error": "HTTP 404 Not Found", "updated_at": "…" }
  ]
}
```

---

## 6. Configuration

Set in Botkeep → OTG-BOT → **Environment**, then restart the server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVER_PORT` / `PORT` | `3000` | HTTP listen port (Botkeep sets `SERVER_PORT` automatically) |
| `DATA_DIR` | `./data` | Where the SQLite file lives |
| `INGEST_TOKEN` | *(unset)* | When set, `/ingest` and `DELETE` require it (see below) |
| `CONCURRENCY` | `2` | Parallel page fetches |
| `POLL_MS` | `2000` | Queue poll interval |
| `FETCH_TIMEOUT_MS` | `20000` | Per-page fetch timeout |
| `MAX_BYTES` | `5000000` | Max HTML bytes per page |
| `MAX_ATTEMPTS` | `3` | Retries before `error` |
| `USER_AGENT` | `OTGBot/1.0` | Fetch user agent |

## 7. Security

By default the API is open — convenient for bookmarklets, but anyone with the
address can save URLs into your store. To lock writing:

1. Set `INGEST_TOKEN=<long-random-string>` in the Environment tab and restart.
2. Send it with every write request:

```sh
curl -X POST http://node4.botkeep.cloud:37112/ingest \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: text/plain' \
  -d 'https://example.com/article'
```

Reads (`GET`) stay open. For private reads, put the service behind a proxy
with auth — the app itself has no user accounts.

## 8. HTTP status codes

| Code | When |
| --- | --- |
| `200` | Successful read, delete, or probe |
| `202` | Ingest accepted (processing happens async) |
| `400` | Malformed body, invalid/missing search query, or unsupported query |
| `401` | Write request without a valid token (when `INGEST_TOKEN` is set) |
| `404` | Unknown path or document id |
| `405` | Method not allowed on a known path |
| `500` | Unexpected server error (check the Botkeep console) |
