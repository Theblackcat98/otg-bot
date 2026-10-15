// Run against a live instance with the fixture server (test/fixtures.ts) on port 3995.
// Example: SERVER_PORT=3996 DATA_DIR=/tmp/otg-test bun dist/index.js
const BASE = process.env.BASE ?? "http://localhost:3996";
const FIX = process.env.FIXTURES ?? "http://localhost:3995";

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else failures.push(`${name}${detail !== undefined ? ` → ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(BASE + path, { ...init, headers, body });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, data };
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 25000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function docByUrl(url: string) {
  const list = await call(`/documents?limit=100`);
  const hit = list.data.documents.find((d: any) => d.url === url);
  return hit ? (await call(`/documents/${hit.id}`)).data : null;
}

const readyDoc = (url: string) =>
  waitFor(async () => {
    const d = await docByUrl(url);
    return d && (d.status === "ready" || d.status === "error") ? d : null;
  });

// ---------------------------------------------------------------- service & UI
{
  const h = await call("/health");
  check("health ok + version 1.1.0", h.data.ok === true && h.data.version === "1.1.0", h.data);

  const ui = await call("/");
  check("GET / serves UI html", ui.status === 200 && String(ui.data).includes("OTG-BOT"), ui.status);
  check("UI has CSP header", (ui.headers.get("content-security-policy") ?? "").includes("default-src 'self'"));

  const api = await call("/api");
  check("GET /api returns endpoint map", api.status === 200 && !!api.data.endpoints?.["POST   /ingest"], api.status);
}

// ---------------------------------------------------------------- ingest + snapshot + cleaning (#1, #10)
{
  const r = await call("/ingest", {
    method: "POST",
    json: { urls: [`${FIX}/p/a1.html`], tags: ["Manual", "Read Later"] },
  });
  check("ingest 202 accepted", r.status === 202 && r.data.accepted === 1, r.data);

  const d = await readyDoc(`${FIX}/p/a1.html`);
  check("a1 scraped ready", d?.status === "ready", d?.last_error);
  check("cleaned content has article text", !!d?.content?.includes("token-a1"));
  check("cleaned content drops nav/header/footer", !!d && !/NAVJUNK|HEADERJUNK|FOOTERJUNK/.test(d.content));
  check("title extracted", d?.title === "a1 page", d?.title);
  check("tags normalised to lowercase", JSON.stringify(d?.tags) === JSON.stringify(["manual", "read later"]), d?.tags);
  check("has_snapshot true", d?.has_snapshot === true, d?.has_snapshot);
  check("notes empty initially", Array.isArray(d?.notes) && d.notes.length === 0);

  const raw = await call(`/documents/${d.id}/raw`);
  check("raw snapshot 200", raw.status === 200, raw.status);
  check("raw snapshot sandboxed CSP", raw.headers.get("content-security-policy") === "sandbox");
  check("raw snapshot has base href", String(raw.data).includes(`<base href="${FIX}/p/a1.html">`));
  check("raw snapshot contains original html", String(raw.data).includes("token-a1"));

  const t = await call(`/documents/${d.id}/tags`, { method: "POST", json: { tags: "X, Y , x" } });
  check("tags replaced + deduped", JSON.stringify(t.data.tags) === JSON.stringify(["x", "y"]), t.data);

  const n = await call(`/documents/${d.id}/notes`, { method: "POST", json: { note: "first note" } });
  check("note added 201", n.status === 201 && n.data.note === "first note", n.data);
  const d2 = (await call(`/documents/${d.id}`)).data;
  check("note appears in detail", d2.notes.length === 1);
  const del = await call(`/documents/${d.id}/notes/${n.data.id}`, { method: "DELETE" });
  check("note deleted", del.status === 200);

  const emptyNote = await call(`/documents/${d.id}/notes`, { method: "POST", json: { note: "  " } });
  check("empty note rejected 400", emptyNote.status === 400, emptyNote.data);

  const byTag = await call(`/documents?tag=x`);
  check("list filter by tag", byTag.data.total === 1 && byTag.data.documents[0].id === d.id, byTag.data.total);

  const s1 = await call(`/search?q=token-a1&tag=x`);
  check("search with tag filter hits", s1.data.results?.length === 1, s1.data);
  const s2 = await call(`/search?q=token-a1&tag=nope`);
  check("search with other tag misses", s2.data.results?.length === 0, s2.data);
  check("search results carry tags", Array.isArray(s1.data.results?.[0]?.tags));

  const txt = await call("/ingest", { method: "POST", headers: { "content-type": "text/plain" }, body: `${FIX}/p/a6.html` });
  check("text/plain ingest accepted", txt.status === 202 && txt.data.accepted === 1, txt.data);
  await readyDoc(`${FIX}/p/a6.html`);

  const dup = await call("/ingest", { method: "POST", json: { url: `${FIX}/p/a1.html`, tags: ["extra"] } });
  check("duplicate reported", dup.data.duplicates.length === 1 && dup.data.accepted === 0, dup.data);
  const merged = (await call(`/documents/${d.id}`)).data;
  check("duplicate merges new tag", merged.tags.includes("extra"), merged.tags);

  const bad = await call("/ingest", { method: "POST", json: { url: "javascript:alert(1)" } });
  check("non-http URL invalid", bad.data.invalid?.length === 1 && bad.data.accepted === 0, bad.data);

  const empty = await call("/ingest", { method: "GET" });
  check("GET ingest without url → 400", empty.status === 400, empty.data);

  const malformed = await call("/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  check("malformed JSON → 400", malformed.status === 400, malformed.data);
}

// ---------------------------------------------------------------- bookmarks import (#3)
{
  const src = await fetch(`${FIX}/bookmarks.html`).then((r) => r.text());
  const imp = await call("/import/bookmarks", { method: "POST", headers: { "content-type": "text/html" }, body: src });
  check("import counts", imp.data.found === 5 && imp.data.imported === 3 && imp.data.duplicates === 1 && imp.data.invalid === 1, imp.data);

  const a2 = await readyDoc(`${FIX}/p/a2.html`);
  check("bookmark folder → tag (dev)", a2?.tags?.includes("dev"), a2?.tags);
  const bm1 = await readyDoc(`${FIX}/p/bm1.html`);
  check("nested folders → tags (dev, rust)", bm1?.tags?.includes("dev") && bm1?.tags?.includes("rust"), bm1?.tags);
  check("bookmarks bar root not a tag", !(bm1?.tags ?? []).includes("bookmarks bar"));
  const bm2 = await readyDoc(`${FIX}/p/bm2.html`);
  check("root-level bookmark has no folder tags", (bm2?.tags ?? []).length === 0, bm2?.tags);
}

// ---------------------------------------------------------------- feeds (#8)
let rssId = 0;
let atomId = 0;
let brokenId = 0;
{
  const add = await call("/feeds", { method: "POST", json: { url: `${FIX}/feed.xml` } });
  check("feed added 201", add.status === 201 && add.data.enabled === true, add.data);
  rssId = add.data.id;

  await readyDoc(`${FIX}/p/a4.html`);
  const a4 = await readyDoc(`${FIX}/p/a4.html`);
  check("rss item a4 ingested", a4?.status === "ready", a4);
  check("rss item tagged with feed title", a4?.tags?.includes("test rss"), a4?.tags);

  const chk = await call(`/feeds/${rssId}/check`, { method: "POST" });
  check("second check is not-modified (etag)", chk.data.status === "not-modified", chk.data);

  const list = await call("/feeds");
  const f = list.data.find((x: any) => x.id === rssId);
  check("feed status recorded", f?.last_status === "not-modified" && f?.title === "Test RSS", f);
  check("feed ingested count", f?.items_ingested === 2, f?.items_ingested);

  const atomAdd = await call("/feeds", { method: "POST", json: { url: `${FIX}/atom.xml` } });
  atomId = atomAdd.data.id;
  const a3 = await readyDoc(`${FIX}/p/a3.html`);
  check("atom entry ingested", a3?.status === "ready" && a3?.tags?.includes("test atom"), a3?.tags);

  const brokenAdd = await call("/feeds", { method: "POST", json: { url: `${FIX}/broken.xml` } });
  brokenId = brokenAdd.data.id;
  await new Promise((r) => setTimeout(r, 1500));
  const bchk = await call(`/feeds/${brokenId}/check`, { method: "POST" });
  check("broken feed → error status", bchk.data.status === "error", bchk.data);
  const bl = (await call("/feeds")).data.find((x: any) => x.id === brokenId);
  check("broken feed error stored", /HTTP 500/.test(bl?.last_error ?? ""), bl);

  const toggle = await call(`/feeds/${brokenId}`, { method: "PATCH", json: { enabled: false } });
  check("feed disabled via PATCH", toggle.data.enabled === false, toggle.data);
  const badToggle = await call(`/feeds/${brokenId}`, { method: "PATCH", json: { enabled: "yes" } });
  check("non-boolean enabled → 400", badToggle.status === 400, badToggle.data);

  const badUrl = await call("/feeds", { method: "POST", json: { url: "ftp://x" } });
  check("invalid feed URL → 400", badUrl.status === 400, badUrl.data);

  const del = await call(`/feeds/${brokenId}`, { method: "DELETE" });
  check("feed deleted", del.status === 200);
  const gone = await call(`/feeds/${brokenId}/check`, { method: "POST" });
  check("check on deleted feed → 404", gone.status === 404);
}

// ---------------------------------------------------------------- settings (UI-managed)
{
  const s = await call("/settings");
  check("default settings", s.data.feed_poll_minutes === "15" && s.data.feeds_enabled === "1" && s.data.snapshots === "1", s.data);

  const up = await call("/settings", { method: "PUT", json: { feed_poll_minutes: 30, feeds_enabled: true } });
  check("settings updated", up.data.feed_poll_minutes === "30" && up.data.feeds_enabled === "1", up.data);

  const badKey = await call("/settings", { method: "PUT", json: { bogus: 1 } });
  check("unknown setting → 400", badKey.status === 400, badKey.data);
  const badRange = await call("/settings", { method: "PUT", json: { feed_poll_minutes: 0 } });
  check("interval 0 → 400", badRange.status === 400, badRange.data);
  const badFlag = await call("/settings", { method: "PUT", json: { snapshots: "maybe" } });
  check("bad flag → 400", badFlag.status === 400, badFlag.data);

  await call("/settings", { method: "PUT", json: { snapshots: false } });
  await call("/ingest", { method: "POST", json: { url: `${FIX}/p/a7.html` } });
  const a7 = await readyDoc(`${FIX}/p/a7.html`);
  check("snapshots off → no snapshot", a7?.status === "ready" && a7?.has_snapshot === false, a7);
  check("snapshots off → raw 404", (await call(`/documents/${a7.id}/raw`)).status === 404);
  await call("/settings", { method: "PUT", json: { snapshots: true } });

  await call("/settings", { method: "PUT", json: { feed_poll_minutes: 15 } });
}

// ---------------------------------------------------------------- list, delete, queue
{
  const list = await call("/documents?limit=5&status=ready");
  check("list with status filter", list.data.documents.every((d: any) => d.status === "ready") && list.data.limit === 5);

  const q = await call("/queue");
  check("queue stats", typeof q.data.byStatus === "object");

  const d = await docByUrl(`${FIX}/p/a7.html`);
  const del = await call(`/documents/${d.id}`, { method: "DELETE" });
  check("document deleted", del.status === 200 && del.data.deleted === d.id);
  check("deleted doc → 404", (await call(`/documents/${d.id}`)).status === 404);
  const fts = await call(`/search?q=token-a7`);
  check("deleted doc removed from FTS", fts.data.results?.length === 0, fts.data);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:\n - " + failures.join("\n - "));
  process.exit(1);
}
