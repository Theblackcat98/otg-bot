# OTG-BOT — URL keeper

A single Bun service that keeps the web for you. Send it links from bookmarks,
share sheets, bookmark exports, or RSS/Atom feeds. A background worker fetches
each page, stores the cleaned text, a raw HTML snapshot, and metadata in an
embedded SQLite database, and makes everything searchable. A built-in web UI
lets you read, tag, annotate, and manage it.

For day-to-day usage see **[DOCS.md](DOCS.md)**.

## Features

- **Web UI** at `/` — library, full-text search, reader view, tags and notes, bookmark import, feed and settings panels.
- **Ingestion API** — single or batch URLs (JSON, form, plain text, or `GET ?url=`), with optional tags.
- **Bookmark import** — browser bookmarks HTML export; folder names become tags.
- **Scraper worker** — concurrent fetches (default 4), size cap, timeout, retries, boilerplate removal (Cheerio).
- **Raw snapshots** — the original HTML of each page, served sandboxed.
- **Tags and notes** — organise and annotate documents; filter lists and search by tag.
- **RSS/Atom watcher** — polls feeds on an interval, ingests new items, tags them with the feed name. Feeds, interval and on/off switch are managed in the UI.
- **ntfy push notifications** — when the feed watcher finds new items, a digest goes to your ntfy topic (phone push). Set `NTFY_TOPIC`; `POST /notify/test` to verify.
- **Full-text search** — SQLite FTS5, prefix matching, ranked, highlighted snippets.

## Architecture

```
bookmarks · share sheets · feeds · web UI
        │  /ingest · /import/bookmarks · /feeds · /documents/*
        ▼
┌──────────────────────┐   ┌────────────────────────┐   ┌──────────────────────────────┐
│  Ingestion API       │──▶│  Scraper worker        │──▶│  Embedded store (bun:sqlite) │
│  src/index.ts        │   │  src/worker.ts         │   │  src/db.ts                   │
│  Web UI (src/ui.html)│   │  src/scraper.ts        │   │  documents · documents_fts   │
│  Bookmark import     │   │  fetch + Cheerio       │   │  snapshots · tags · notes    │
│  Feed watcher        │   │  clean text + metadata │   │  feeds · settings            │
│  src/feeds.ts        │   └────────────────────────┘   └──────────────────────────────┘
└──────────────────────┘
```

- **Ingestion API** — `src/index.ts`: `Bun.serve` router, validation, bookmark import, write-token check.
- **Web UI** — `src/ui.html`: a single HTML file (no build step), embedded into the bundle as text.
- **Feed watcher** — `src/feeds.ts`: RSS 2.0 and Atom parsing, ETag / If-Modified-Since, per-feed status.
- **Scraper worker** — `src/worker.ts` + `src/scraper.ts`: claims queued documents, streams the body with a size cap, decodes the charset, extracts metadata and article text.
- **Embedded store** — `src/db.ts`: WAL-mode SQLite. Schema is created with `CREATE … IF NOT EXISTS`, so upgrades add tables without migrations.

## Run

```sh
bun install
bun run src/index.ts        # development
```

### Production bundle

Botkeep caps archive extraction at 250 entries, which `node_modules` exceeds.
`dist/index.js` is a self-contained bundle (cheerio and the UI included):

```sh
bun build src/index.ts --target=bun --outfile dist/index.js --external bun:sqlite
bun dist/index.js           # deployed start command: bun run dist/index.js
```

Open `http://localhost:3000/` for the UI.

## API

The full reference with examples is in [DOCS.md](DOCS.md). Summary:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Web UI |
| GET | `/api` | Service info and endpoint map |
| GET | `/health` | Liveness probe |
| POST | `/ingest` · GET `/ingest?url=` | Save URL(s), optional `tags` |
| POST | `/import/bookmarks` | Import a bookmarks HTML export |
| GET | `/documents` | List (`status`, `tag`, `limit`, `offset`) |
| GET · DELETE | `/documents/:id` | Document detail (content, tags, notes) · delete |
| GET | `/documents/:id/raw` | Stored HTML snapshot (sandboxed) |
| POST | `/documents/:id/tags` | Replace tags |
| POST | `/documents/:id/notes` · DELETE `/documents/:id/notes/:noteId` | Add · delete note |
| GET | `/search?q=&tag=` | Full-text search |
| GET · POST | `/feeds` | List · add feed |
| PATCH · DELETE | `/feeds/:id` | Enable/disable · remove feed |
| POST | `/feeds/:id/check` | Check a feed now |
| GET · PUT | `/settings` | Runtime settings |
| GET | `/queue` | Worker queue statistics |
| POST | `/notify/test` | Send a test ntfy notification (needs `NTFY_TOPIC`) |

Every write (POST, PUT, PATCH, DELETE) requires `INGEST_TOKEN` when it is set.

## Configuration

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVER_PORT` / `PORT` | `3000` | HTTP listen port. Botkeep sets `SERVER_PORT`, which takes precedence. |
| `DATA_DIR` | `./data` | Directory of the SQLite file `otg.sqlite` |
| `INGEST_TOKEN` | *(unset)* | When set, all writes need `Authorization: Bearer …` or `?token=` |
| `CONCURRENCY` | `4` | Parallel page fetches in the worker |
| `POLL_MS` | `2000` | Queue poll interval |
| `FETCH_TIMEOUT_MS` | `20000` | Per-page fetch timeout |
| `MAX_BYTES` | `5000000` | Maximum HTML bytes fetched per page |
| `MAX_ATTEMPTS` | `3` | Attempts before a document is marked `error` |
| `SNAPSHOTS` | `1` | Set to `0` to disable snapshot storage entirely |
| `NTFY_TOPIC` | *(unset)* | ntfy topic for push notifications; unset disables them. Use a hard-to-guess topic on the public server (e.g. `otg-<random>`) |
| `NTFY_URL` | `https://ntfy.sh` | ntfy server (self-hosted or paid tiers) |
| `NTFY_TOKEN` | *(unset)* | Bearer token when the ntfy server requires auth |
| `USER_AGENT` | `Mozilla/5.0 (compatible; OTGBot/1.0; …)` | User agent for page and feed fetches |

### Runtime settings (managed in the UI or `PUT /settings`)

| Key | Default | Meaning |
| --- | --- | --- |
| `feed_poll_minutes` | `15` | Feed check interval, 1–1440 |
| `feeds_enabled` | `1` | Feed watcher on (`1`) or off (`0`) |
| `snapshots` | `1` | Store raw snapshots for newly scraped pages |

## Document lifecycle

`queued → processing → ready`, or `error` after `MAX_ATTEMPTS` failed tries.
Documents left in `processing` by a restart are re-queued at boot. Re-saving a
URL that already exists does not re-scrape it; delete it first to refresh.

## Testing

The end-to-end suite (`test/e2e.ts`) checks every endpoint against a live
instance. It uses a fixture server (`test/fixtures.ts`) that serves pages, RSS,
Atom, an ETag-aware feed, a failing feed and a bookmarks export.

```sh
bun run build
bun run test:fixtures &                                                     # port 3995
SERVER_PORT=3996 DATA_DIR=/tmp/otg-test NTFY_TOPIC=otg-test NTFY_URL=http://localhost:3995/ntfy bun dist/index.js &
bun run test:e2e                              # expects 65 passing checks
```

## Deployed on Botkeep

Server **OTG-BOT** (Bun 1.4.2), start command `bun run dist/index.js`.
Public address: `http://node4.botkeep.cloud:37112/` — plain HTTP, no TLS.
