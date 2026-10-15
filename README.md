# OTG-BOT — URL keeper pipeline

A single Bun service that keeps URLs you throw at it: it ingests them through a
small HTTP API, scrapes each page in a background worker, and stores cleaned
text plus raw metadata in an embedded SQLite database with full-text search.

## Architecture

```
bookmarks / share sheets
        │  POST|GET /ingest
        ▼
┌──────────────────┐      ┌────────────────────┐      ┌──────────────────────┐
│  Ingestion API   │ ───▶ │   Scraper worker   │ ───▶ │    Embedded store    │
│  (Bun.serve)     │      │ fetch + Cheerio    │      │ bun:sqlite + FTS5    │
│  enqueue URLs    │      │ clean text, meta   │      │ content, metadata,   │
└──────────────────┘      └────────────────────┘      │ search index         │
                                                      └──────────────────────┘
```

- **Ingestion API** — `src/index.ts`: Bun HTTP server. Accepts single URLs or
  batches as JSON, form data, plain text (share-sheet style) or `?url=` on GET.
- **Scraper worker** — `src/worker.ts` + `src/scraper.ts`: polls the queue
  (configurable concurrency), fetches with a size cap and timeout, strips
  boilerplate, extracts title/description/author/canonical/image and the
  article text with Cheerio.
- **Embedded store** — `src/db.ts`: `bun:sqlite` (WAL mode). `documents` table
  holds cleaned content and raw metadata (meta tags, link tags, JSON-LD,
  response info); `documents_fts` is an FTS5 index kept in sync automatically.

## Run

```sh
bun install
bun run src/index.ts        # dev start command: bun run src/index.ts
```

### Production bundle

`dist/index.js` is a self-contained Bun bundle (cheerio included) so the
server needs no install or build step at boot. It is **committed to this
repo** so a Botkeep GitHub pull can run immediately:

```sh
bun build src/index.ts --target=bun --outfile dist/index.js --external bun:sqlite
bun dist/index.js           # deployed start command: bun run dist/index.js
```

After changing `src/`, rebuild the bundle and commit it, or the pulled
deployment will run the stale bundle. (Botkeep also runs `bun install`
automatically at boot, so `bun run src/index.ts` would work there too — point
the startup command at it if you prefer no committed bundle.)

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | liveness probe |
| GET | `/` | service info + endpoint map |
| POST | `/ingest` | submit URL(s): `{"url"}` \| `{"urls":[…]}` \| `url=…` form \| plain text |
| GET | `/ingest?url=…` | bookmarklet / share-sheet friendly submission |
| GET | `/documents?limit=&offset=&status=` | list documents (excerpt view) |
| GET | `/documents/:id` | full document incl. cleaned content + raw metadata |
| DELETE | `/documents/:id` | remove a document |
| GET | `/search?q=…` | full-text search (FTS5, ranked) |
| GET | `/queue` | worker queue statistics |

### Examples

```sh
# single URL
curl -X POST https://host/ingest -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article"}'

# batch
curl -X POST https://host/ingest -H 'content-type: application/json' \
  -d '{"urls":["https://a.example","https://b.example"]}'

# share sheet / plain text
curl -X POST https://host/ingest -H 'content-type: text/plain' \
  -d 'https://example.com/article'

# list, read, search
curl https://host/documents?limit=10
curl https://host/documents/42
curl 'https://host/search?q=sqlite'
```

### Bookmarklet

```js
javascript:location.href='https://YOUR-HOST/ingest?url='+encodeURIComponent(location.href)
```

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port (Botkeep sets `SERVER_PORT`; that takes precedence) |
| `DATA_DIR` | `./data` | where the SQLite file lives |
| `INGEST_TOKEN` | *(unset)* | when set, `/ingest` and DELETE require `Authorization: Bearer …` or `?token=` |
| `CONCURRENCY` | `2` | parallel fetches in the worker |
| `POLL_MS` | `2000` | queue poll interval |
| `FETCH_TIMEOUT_MS` | `20000` | per-page fetch timeout |
| `MAX_BYTES` | `5000000` | max HTML bytes fetched per page |
| `MAX_ATTEMPTS` | `3` | retries before a URL is marked `error` |
| `USER_AGENT` | `OTGBot/1.0` | fetch user agent |

## Document lifecycle

`queued → processing → ready`, or `error` after `MAX_ATTEMPTS` failed tries.
Interrupted `processing` rows are re-queued automatically on restart.

## Deployed on Botkeep

Server: **OTG-BOT** (Bun 1.4.2) — start command `bun run dist/index.js`
(self-contained bundle; see "Production bundle" above).
