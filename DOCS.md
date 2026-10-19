# OTG-BOT — Usage guide

OTG-BOT keeps pages you want to read later. Send it links from bookmarks,
share sheets, bookmark exports, or RSS/Atom feeds. It fetches each page, keeps
the cleaned text and the original HTML, and makes everything searchable. You can
tag and annotate pages, and browse everything in the web UI.

- **Web UI:** http://node4.botkeep.cloud:37112/
- **API base:** the same address. Example below uses `$BASE`:

```sh
BASE=http://node4.botkeep.cloud:37112
```

> The Botkeep address is plain HTTP (no TLS). Do not send secrets through it.
> If you set `INGEST_TOKEN`, see [Security](#10-security).

---

## 1. Web UI

Open `$BASE/` in a browser. Three views are in the top bar:

| View | What you do there |
| --- | --- |
| **Library** | Save URLs, search, filter by status or tag, import bookmarks, open a document |
| **Feeds** | Add RSS/Atom feeds, enable or disable them, check now, remove them |
| **Settings** | Set the feed check interval, turn the watcher on or off, turn snapshots on or off, store the API token |

The status dot in the top bar shows whether the server answers. The counts beside it
show `ready`, `queued` (including `processing`) and `error` documents.

**Reader view.** Click a title to open a document. The reader shows the cleaned
text, the original link, the snapshot link, the tags, and the notes. From there you
can edit tags, add or delete notes, and delete the document.

---

## 2. Save a URL

### In the UI

Paste one or more URLs (space or newline separated) in the top field. Optionally
add tags, comma separated, then press **Save**.

### With the API

```sh
# JSON, one URL with tags
curl -X POST $BASE/ingest -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article","tags":["research","go"]}'

# JSON, batch (max 25 per request)
curl -X POST $BASE/ingest -H 'content-type: application/json' \
  -d '{"urls":["https://a.example/one","https://b.example/two"]}'

# Plain text: one or many URLs, whitespace separated (share sheets, shell pipes)
curl -X POST "$BASE/ingest?tags=news" -H 'content-type: text/plain' \
  -d 'https://example.com/article'

# Form encoded
curl -X POST $BASE/ingest -d 'url=https://example.com/article&tags=research'

# GET (bookmarklets, automation, one-liners)
curl "$BASE/ingest?url=https://example.com/article&tags=research"
```

Response, `202 Accepted`:

```json
{
  "accepted": 1,
  "queued": [{ "id": 12, "url": "https://example.com/article" }],
  "duplicates": [],
  "invalid": [],
  "tags": ["research", "go"],
  "overflowSkipped": 0
}
```

- `queued`: new documents, waiting for the worker.
- `duplicates`: URLs already stored. They are not scraped again, but the tags you
  sent are added to them.
- `invalid`: input that is not an `http://` or `https://` URL.
- `overflowSkipped`: URLs beyond the 25-per-request limit.

### Bookmarklet

Create a bookmark whose address is this line, then click it on any page:

```js
javascript:location.href='http://node4.botkeep.cloud:37112/ingest?url='+encodeURIComponent(location.href)
```

### Share sheets

Any app that can open a URL or send a POST can submit. For example, use an iOS
Shortcut with "Get contents of URL" and the shared page as the URL, or an Android
HTTP Shortcut with a `text/plain` body.

---

## 3. Import bookmarks

Export your browser bookmarks as HTML, then import the file.

- **Chrome:** Bookmark manager → ⋮ → *Export bookmarks*.
- **Firefox:** Library → *Import and Backup* → *Export Bookmarks to HTML*.
- **Edge:** Favourites → ⋯ → *Export favourites*.

In the UI, click **Import bookmarks…** in the Library and pick the file. Or send it directly:

```sh
curl -X POST $BASE/import/bookmarks -H 'content-type: text/html' \
  --data-binary @bookmarks.html
```

```json
{ "found": 812, "imported": 790, "duplicates": 20, "invalid": 2, "truncated": false }
```

How the file is read:

- Each bookmark becomes a document. Duplicates and non-web links are counted and skipped.
- Each **folder** in the bookmark's path becomes a **tag**, in lower case.
  For example, `Dev / Rust / Ownership` gives the tags `dev` and `rust`.
- The top-level folders `Bookmarks bar`, `Bookmarks toolbar`, `Bookmarks menu`,
  `Other bookmarks` and `Mobile bookmarks` are not used as tags.
- Up to 10,000 bookmarks are read per request. `truncated` is `true` if the file had more.

---

## 4. What happens after you save

Each document moves through these states:

```
queued ──▶ processing ──▶ ready
    ▲            │
    └── retry ◀──┴──▶ error      (after 3 failed attempts)
```

The worker (4 parallel fetches by default):

- fetches the page with a 20 s timeout and a 5 MB cap,
- follows redirects,
- removes boilerplate (navigation, headers, footers, scripts, asides),
- extracts the title, description, author, site name, canonical URL, preview
  image and the article text,
- stores the **original HTML** as a snapshot (see [Snapshots](#5-snapshots)),
- updates the search index.

A page that cannot be read (for example HTTP 404 or an unsupported content type)
ends in `error`. The reason is stored in `last_error`. Check `/queue` or filter the
library by **error**. Documents left in `processing` by a server restart return to
`queued` automatically.

To retry a failed or outdated page, delete it and save it again.

---

## 5. Snapshots

A snapshot is the page as it was when it was fetched. It is kept even if the
site changes or goes offline.

- Open it from the reader view (**Snapshot ↗**), or:

  ```sh
  curl $BASE/documents/12/raw          # HTML, served sandboxed
  ```

- Snapshots are sandboxed. Scripts do not run, and the page cannot read
  cookies or storage of this site. Images and stylesheets load from the
  original site.
- Snapshots are stored for newly scraped pages only while the **Store raw HTML
  snapshots** setting is on (Settings view, or `PUT /settings` with
  `"snapshots": false`). The server also accepts `SNAPSHOTS=0` to disable them.
- A document without a snapshot returns `404` from `/raw`.

---

## 6. Tags and notes

### Tags

- Tags are lower case, trimmed, de-duplicated, up to 64 characters, and up to 32 per document.
- They come from the save request, the bookmark folders, or the feed name.
- Edit them in the reader view, or replace them with the API. Replacing removes the old set:

  ```sh
  curl -X POST $BASE/documents/12/tags -H 'content-type: application/json' \
    -d '{"tags":["rust","async","to-read"]}'
  ```

- Filter any list or search by tag: `GET /documents?tag=rust`, `GET /search?q=async&tag=rust`.
- Click a tag chip in the UI to filter by it.

### Notes

Notes are free text, up to 8,000 characters each. A document can have many notes.

```sh
curl -X POST $BASE/documents/12/notes -H 'content-type: application/json' \
  -d '{"note":"Compare with the 2024 article."}'          # → 201 {id, note, created_at}

curl -X DELETE $BASE/documents/12/notes/5
```

Notes appear in the document detail and in the reader view.

---

## 7. Search

```sh
curl "$BASE/search?q=sqlite"
curl "$BASE/search?q=type+checks&tag=typescript&limit=5"
```

- Searches the title, description and cleaned text (SQLite FTS5).
- Each word is a **prefix** match: `type` also matches *types* and *typescript*.
  All words must match (AND).
- Punctuation is ignored. A query with no letters or digits returns `400`.
- Results are ranked by relevance (`rank`, lower is better). Each result has a
  `snippet` with `<mark>` around the matches, plus its `tags`.
- Parameters: `q` (required), `tag`, `limit` (1–50, default 20), `offset`.

---

## 8. RSS and Atom feeds

Add a feed and OTG-BOT saves every new item link in it. Feeds are managed in the
**Feeds** view or with the API.

```sh
# add (checked immediately in the background)
curl -X POST $BASE/feeds -H 'content-type: application/json' \
  -d '{"url":"https://example.com/feed.xml"}'

curl $BASE/feeds                                  # list with status
curl -X PATCH $BASE/feeds/3 -H 'content-type: application/json' -d '{"enabled":false}'
curl -X POST $BASE/feeds/3/check                  # check now → {"ingested":2,"status":"ok"}
curl -X DELETE $BASE/feeds/3                      # removes the feed; saved items stay
```

How the watcher behaves:

- It checks every enabled feed once per **interval** (Settings, default 15 minutes,
  range 1–1440). The first check runs about a minute after the server starts.
- Feeds use conditional requests (ETag and Last-Modified). An unchanged feed is
  reported as `not-modified` and costs almost nothing.
- Up to 50 items are read per check. Each new link becomes a document, tagged
  with the feed's title in lower case.
- A failing feed keeps its last error in the list (for example `HTTP 500`). Other
  feeds are still checked.
- **Check now** works on disabled feeds too.
- Turn the whole watcher off in Settings. Feeds stay configured.

Feed status values: `ok`, `not-modified`, `error`, or `never` (not checked yet).

---

## 9. Settings

Runtime settings are stored in the database and changed in the **Settings** view
or with `PUT /settings`. They take effect without a restart.

| Key | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `feed_poll_minutes` | `15` | integer 1–1440 | How often feeds are checked |
| `feeds_enabled` | `1` | `0` or `1` | Feed watcher on or off |
| `snapshots` | `1` | `0` or `1` | Keep HTML snapshots of new pages |

```sh
curl $BASE/settings
curl -X PUT $BASE/settings -H 'content-type: application/json' \
  -d '{"feed_poll_minutes":30,"snapshots":false}'
```

Unknown keys and invalid values return `400`.

---

## 10. Security

By default the API is open: anyone with the address can read and write.
To lock writes:

1. Set `INGEST_TOKEN=<long-random-string>` in Botkeep → OTG-BOT → **Environment**, then restart.
2. Send the token with every write:

   ```sh
   curl -X POST $BASE/ingest -H 'authorization: Bearer <token>' \
     -H 'content-type: text/plain' -d 'https://example.com/article'
   ```

   Or append `?token=<token>` to the URL. This works for bookmarklets, but the
   token may appear in logs. Prefer the header.

Protected writes are every POST, PUT, PATCH and DELETE. Reads (GET) stay open.

In the UI, enter the token once in **Settings → API token**. It is stored in this
browser only.

The app has no user accounts. For private reads, put the service behind an
authenticating proxy.

---

## 11. Monitor

```sh
curl $BASE/health      # {"ok": true, "version": "1.2.0", "uptimeSeconds": 4210}
curl $BASE/queue       # counts by status + the last 10 errors with reasons
curl $BASE/api         # endpoint map, version, document counts
```

---

## 12. API reference

| Method | Path | Body / query | Success | Notes |
| --- | --- | --- | --- | --- |
| GET | `/` | | 200 HTML | Web UI |
| GET | `/api` | | 200 | Endpoint map |
| GET | `/health` | | 200 | Liveness |
| POST | `/ingest` | `{url}` / `{urls, tags}` / form / text | 202 | Token if set |
| GET | `/ingest` | `?url=…&tags=…` | 202 | Token if set |
| POST | `/import/bookmarks` | Netscape HTML | 200 | Token if set |
| GET | `/documents` | `limit`, `offset`, `status`, `tag` | 200 `{total, documents}` | |
| GET | `/documents/:id` | | 200 | Content, metadata, `tags`, `notes`, `has_snapshot` |
| DELETE | `/documents/:id` | | 200 `{deleted}` | Token if set |
| GET | `/documents/:id/raw` | | 200 HTML | Sandboxed snapshot |
| POST | `/documents/:id/tags` | `{tags}` | 200 `{tags}` | Replaces tags |
| POST | `/documents/:id/notes` | `{note}` | 201 | |
| DELETE | `/documents/:id/notes/:noteId` | | 200 | |
| GET | `/search` | `q` (required), `tag`, `limit`, `offset` | 200 `{results}` | |
| GET | `/feeds` | | 200 array | |
| POST | `/feeds` | `{url}` | 201 | Starts a background check |
| PATCH | `/feeds/:id` | `{enabled}` | 200 | |
| POST | `/feeds/:id/check` | | 200 `{ingested, status}` | |
| DELETE | `/feeds/:id` | | 200 | Items are kept |
| GET | `/settings` | | 200 | |
| PUT | `/settings` | any of the keys in §9 | 200 | |
| GET | `/queue` | | 200 | |
| POST | `/notify/test` | | 200 `{sent}` | Needs `NTFY_TOPIC`; token if set |

---

## 13. Status codes

| Code | Meaning |
| --- | --- |
| 200 | Success |
| 201 | Created (note, feed) |
| 202 | Accepted: URLs queued, scraping happens in the background |
| 400 | Bad input: malformed body, invalid URL, missing query, invalid setting |
| 401 | Write without a valid token (only when `INGEST_TOKEN` is set) |
| 404 | Unknown path, document, note, feed, or snapshot |
| 405 | Method not allowed on that path |
| 500 | Unexpected error. Check the Botkeep console. |

---

## 14. Configuration

Environment variables are set in Botkeep → OTG-BOT → **Environment**, followed by a restart.
Runtime settings (§9) do not need a restart.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVER_PORT` / `PORT` | `3000` | Listen port (Botkeep sets `SERVER_PORT`) |
| `DATA_DIR` | `./data` | Location of `otg.sqlite` |
| `INGEST_TOKEN` | *(unset)* | Require a token for writes |
| `CONCURRENCY` | `4` | Parallel page fetches |
| `FETCH_TIMEOUT_MS` | `20000` | Page fetch timeout |
| `MAX_BYTES` | `5000000` | Maximum HTML per page |
| `MAX_ATTEMPTS` | `3` | Tries before a page is marked `error` |
| `SNAPSHOTS` | `1` | `0` disables snapshot storage |
| `NTFY_TOPIC` | *(unset)* | ntfy topic for push notifications; unset = disabled |
| `NTFY_URL` | `https://ntfy.sh` | ntfy server (self-hosted or paid tiers) |
| `NTFY_TOKEN` | *(unset)* | Bearer token when the ntfy server requires auth |
| `USER_AGENT` | `OTGBot/1.0` | Sent with page and feed requests |

---

## 15. Push notifications (ntfy)

otg-bot can push to your phone via [ntfy](https://ntfy.sh) — a simple
HTTP-based pub/sub notification service with free Android/iOS apps.

**Setup**

1. Install the ntfy app and subscribe to a topic. Pick a hard-to-guess name —
   anyone who guesses a public ntfy.sh topic can read it (e.g. `otg-x7q2m9`).
2. Set `NTFY_TOPIC=<your-topic>` in Botkeep → OTG-BOT → **Environment**, then restart.
   `NTFY_URL` (default `https://ntfy.sh`) and `NTFY_TOKEN` (bearer auth for
   self-hosted or paid tiers) are optional.
3. Verify:

   ```sh
   curl -X POST $BASE/notify/test        # 200 {"sent": true, ...}
   ```

**What you get notified about**

When a feed poll ingests new items, one digest goes out per poll:

```
3 new items
• Test RSS: 2
• Test Atom: 1
```

Notifications are fire-and-forget: a failed publish is logged and never breaks
ingestion or the worker. If `NTFY_TOPIC` is unset, `POST /notify/test` returns
503 and no notifications are sent.
