# AGENTS.md

Single-package Bun service: URL keeper (ingestion API + scraper worker + SQLite
store + web UI). Deployed on Botkeep as server **OTG-BOT** — plain HTTP at
`http://node4.botkeep.cloud:37112/`. Repo: github.com/Theblackcat98/otg-bot, branch `main`.

## The deployed artifact is `dist/index.js`, not `src/`

- Botkeep's start command is `bun run dist/index.js`. Editing `src/` alone
  changes nothing in production.
- After any `src/` change (including `src/ui.html`): run `bun run build` and
  commit the rebuilt `dist/index.js` — it is tracked in git.
- `src/ui.html` is imported as text into the bundle (`with { type: "text" }`),
  so UI edits also require a rebuild.
- The bundle exists because Botkeep caps archive extraction at 250 entries
  while `node_modules` is >1300 files. Never "fix" deployment by vendoring
  `node_modules`.

## Config gotchas

- Listen on `SERVER_PORT` (Botkeep assigns it): precedence is
  `SERVER_PORT ?? PORT ?? 3000`. Binding to a hardcoded 3000 made the first
  deploy unreachable.
- The version lives in two places: `VERSION` in `src/index.ts` and
  `package.json`. Bump both.
- All non-GET requests require `INGEST_TOKEN` (Bearer header or `?token=`) when
  it is set. The check is central in `route()` — new write routes inherit it;
  do not add per-route auth.

## Architecture notes that are easy to miss

- `src/db.ts` owns all SQL. The schema is one `CREATE TABLE IF NOT EXISTS`
  block run at import — new tables auto-create on boot, there are no migration
  files.
- The FTS index is maintained by hand: call `indexDocument()` after changing a
  document's title/description/content; `deleteDocument()` cascades
  snapshots/tags/notes.
- The endpoint map in `GET /api` (`src/index.ts`) duplicates the route table —
  update it when adding or changing routes.
- Worker claims jobs with `UPDATE … RETURNING`; re-queues `processing` rows at
  boot. Default `CONCURRENCY=4`.
- Feeds settings (`feeds_enabled`, `feed_poll_minutes`, `snapshots`) live in the
  settings table and are edited in the web UI — not env vars (`SNAPSHOTS=0` is
  the only env kill switch for snapshots).
- Re-ingesting an existing URL does not re-scrape it (it reports `duplicates`
  but merges new tags). To refresh a page: `DELETE /documents/:id`, then
  re-ingest.
- `parseBookmarks` intentionally probes three DOM layouts for folder names:
  Netscape exports often leave `<DT>` unclosed, which shifts where `<DL>`
  nests. Keep the multi-candidate lookup.

## Tests

The e2e suite runs against the **built bundle** and a **fresh database**
(it asserts exact counts), with both fixture and app servers running:

```sh
bun run build
bun run test:fixtures &                    # fixtures on :3995
SERVER_PORT=3996 DATA_DIR=/tmp/otg-test bun dist/index.js &
bun run test:e2e                           # 62 checks; override ports with BASE / FIXTURES
```

Reusing an old `DATA_DIR` produces false failures.

## Docs to keep in sync

- `README.md` — overview, architecture, configuration
- `DOCS.md` — user-facing usage guide (UI, API, bookmarks, feeds, settings)

## Deploy flow

1. `bun run build`
2. Upload `dist/index.js` into `/dist` via the Botkeep Files manager (enable
   "Replace existing files").
3. Restart the server (Overview page). The platform runs `bun install` on boot,
   but the bundle needs no installed dependencies.
4. Verify: `curl http://node4.botkeep.cloud:37112/health` shows the expected
   version. Restarts occasionally wedge — if health stays down, Force stop then
   Start.
