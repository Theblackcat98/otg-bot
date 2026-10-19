const port = 3995;
const base = `http://localhost:${port}`;

// Captured ntfy publishes (POST /ntfy/<topic>) for the e2e suite.
const ntfyPosts: { topic: string; body: string; headers: Record<string, string> }[] = [];

const page = (name: string) => `<!doctype html>
<html lang="en"><head>
<title>${name} page</title>
<meta name="description" content="About ${name}">
<meta property="og:site_name" content="FixtureSite">
<link rel="canonical" href="${base}/p/${name}.html">
</head><body>
<nav>NAVJUNK menu links</nav>
<header>HEADERJUNK</header>
<article><h1>${name} heading</h1>
<p>Paragraph with token-${name} and some words for counting.</p>
<p>Second paragraph about indexing.</p></article>
<footer>FOOTERJUNK</footer>
</body></html>`;

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test RSS</title><link>${base}/</link><description>d</description>
<item><title>A4</title><link>${base}/p/a4.html</link><guid>a4</guid></item>
<item><title>A5</title><link>${base}/p/a5.html</link><guid>a5</guid></item>
</channel></rss>`;

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Test Atom</title>
<entry><title>A3</title><link rel="alternate" href="${base}/p/a3.html"/><id>urn:a3</id></entry>
</feed>`;

const bookmarks = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="${base}/p/a1.html" ADD_DATE="1700000001">A1 top</A>
        <DT><H3 ADD_DATE="1700000002">Dev</H3>
        <DL><p>
            <DT><A HREF="${base}/p/a2.html">A2 dev</A>
            <DT><H3>Rust</H3>
            <DL><p>
                <DT><A HREF="${base}/p/bm1.html">Deep rust</A>
            </DL><p>
        </DL><p>
        <DT><A HREF="javascript:void(0)">bad</A>
    </DL><p>
    <DT><A HREF="${base}/p/bm2.html">Other</A>
</DL><p>`;

Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const html = { "content-type": "text/html; charset=utf-8" };
    const xml = { "content-type": "application/xml" };

    if (pathname.startsWith("/p/")) {
      const name = pathname.slice(3).replace(/\.html$/, "");
      return new Response(page(name), { headers: html });
    }
    if (pathname === "/feed.xml") {
      if (req.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
      return new Response(rss, { headers: { ...xml, etag: '"v1"' } });
    }
    if (pathname === "/atom.xml") return new Response(atom, { headers: xml });
    if (pathname === "/broken.xml") return new Response("nope", { status: 500 });
    if (pathname === "/bookmarks.html") return new Response(bookmarks, { headers: html });
    if (pathname === "/__ntfy-posts") {
      return new Response(JSON.stringify(ntfyPosts), {
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname.startsWith("/ntfy/") && req.method === "POST") {
      ntfyPosts.push({
        topic: decodeURIComponent(pathname.slice(6)),
        body: await req.text(),
        headers: Object.fromEntries(req.headers.entries()),
      });
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`fixtures on ${base}`);
