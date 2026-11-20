/**
 * Two tiny demo websites, one per demo project, each on its own port so each
 * has its own origin. The page embeds the Astrolabe tracker with the website id
 * of the project and a subresource integrity hash.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import pg from "pg";

const ingest = (process.env["PARALLAX_INGEST_URL"] ?? "http://localhost:8080").replace(/\/$/, "");
const tracker = readFileSync(new URL("../../apps/gateway/src/tracker/parallax.js", import.meta.url));
const integrity = `sha384-${createHash("sha384").update(tracker).digest("base64")}`;

const SITES = [
  { tenant: "demo-wallet", port: 8090, title: "Demo Wallet", pages: ["/", "/send", "/receive", "/history"] },
  { tenant: "demo-explorer", port: 8092, title: "Demo Explorer", pages: ["/", "/ledgers", "/assets"] },
];

function page(site: (typeof SITES)[number], websiteId: string, path: string): string {
  const links = site.pages.map((p) => `<a href="${p}">${p === "/" ? "home" : p.slice(1)}</a>`).join(" · ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${site.title}${path === "/" ? "" : ` · ${path.slice(1)}`}</title>
<script defer src="${ingest}/v/0.1.0/parallax.js" data-website="${websiteId}"
        integrity="${integrity}" crossorigin="anonymous"></script>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px}code{background:#8882;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>${site.title}</h1>
<p>${links}</p>
<p>This page is measured by Astrolabe. Open the browser's network tab: a challenge, a token, then one event per page view. No cookies are set.</p>
<p>Current page: <code>${path}</code></p>
<p><button onclick="parallax.track('demo-click', {page: location.pathname})">Send a named event</button></p>
</body></html>`;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: 1 });
  const ids = new Map<string, string>();
  for (let attempt = 1; ids.size < SITES.length; attempt++) {
    const result = await pool.query<{ id: string; website_id: string }>("select id, website_id from parallax.tenant").catch(() => null);
    for (const row of result?.rows ?? []) ids.set(row.id, row.website_id);
    if (ids.size < SITES.length) {
      if (attempt > 30) throw new Error("demo projects are not enrolled; run the seed step first");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  await pool.end();

  for (const site of SITES) {
    const websiteId = ids.get(site.tenant) as string;
    createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] as string;
      if (!site.pages.includes(path)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(site, websiteId, path));
    }).listen(site.port, () => console.log(JSON.stringify({ level: "info", msg: "demo site listening", site: site.tenant, port: site.port })));
  }
}

void main();
