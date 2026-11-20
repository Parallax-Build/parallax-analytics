import type { ProjectSummary } from "./store.ts";

/** Server-rendered operator console: every project side by side. Read-only. */

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const int = new Intl.NumberFormat("en-US");

function pct(value: number | null): string {
  return value === null ? "–" : `${(value * 100).toFixed(1)}%`;
}

function ms(value: number | null): string {
  return value === null ? "–" : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

function trafficBar(t: ProjectSummary["traffic"]): string {
  const total = t.confident + t.lowConfidence + t.automated + t.rejected;
  if (total === 0) return '<div class="bar empty"></div><div class="legend">no events yet</div>';
  const part = (n: number, cls: string, label: string): string =>
    n === 0 ? "" : `<span class="${cls}" style="flex:${n}" title="${esc(label)}: ${int.format(n)}"></span>`;
  const item = (n: number, cls: string, label: string): string =>
    `<span><i class="${cls}"></i>${esc(label)} <b>${int.format(n)}</b></span>`;
  return `<div class="bar">${part(t.confident, "c", "confident")}${part(t.lowConfidence, "l", "low confidence")}${part(t.automated, "a", "automated")}${part(t.rejected, "r", "rejected")}</div>
<div class="legend">${item(t.confident, "c", "confident")}${item(t.lowConfidence, "l", "low confidence")}${item(t.automated, "a", "automated")}${item(t.rejected, "r", "rejected")}</div>
${t.topRejection ? `<div class="note">top rejection: <code>${esc(t.topRejection)}</code></div>` : ""}`;
}

function apiCell(api: ProjectSummary["api"]): string {
  if (!api) return '<span class="muted">no API enrolled</span>';
  const errorRate = api.calls > 0 ? api.errors / api.calls : null;
  const rows = api.routes
    .slice(0, 6)
    .map(
      (r) =>
        `<tr><td><code>${esc(r.method)} ${esc(r.route)}</code></td><td class="num">${int.format(r.calls)}</td><td class="num">${ms(r.p95Ms)}</td></tr>`,
    )
    .join("");
  return `<div class="kpis"><div><b>${int.format(api.calls)}</b><span>requests</span></div><div><b>${pct(errorRate)}</b><span>5xx</span></div><div><b>${ms(api.p95Ms)}</b><span>p95</span></div></div>
<table class="routes"><thead><tr><th>route</th><th class="num">requests</th><th class="num">p95</th></tr></thead><tbody>${rows}</tbody></table>
${api.routes.length > 6 ? `<div class="note">${api.routes.length - 6} more routes</div>` : ""}`;
}

export function renderOperatorPage(projects: ProjectSummary[], windowLabel: string, generatedAt: Date): string {
  const cards = projects
    .map(
      (p) => `<article>
  <header><h2>${esc(p.name)}</h2><div class="muted"><code>${esc(p.id)}</code> · ${p.domains.map(esc).join(", ")}</div></header>
  <section><h3>Web</h3>
    <div class="kpis"><div><b>${int.format(p.web.pageviews)}</b><span>page views</span></div><div><b>${int.format(p.web.visitors)}</b><span>visitors</span></div><div><b>${pct(p.web.bounceRate)}</b><span>bounce rate</span></div></div>
  </section>
  <section><h3>Traffic classes at the gateway</h3>${trafficBar(p.traffic)}</section>
  <section><h3>API</h3>${apiCell(p.api)}</section>
</article>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Astrolabe operator console</title>
<style>
:root{--bg:#F5F6F9;--surface:#fff;--fg:#161B2E;--muted:#5B6278;--line:#C3C8D6;--keep:#0B6B83;--low:#C28A1A;--auto:#7A6FB0;--drop:#B23A30}
@media (prefers-color-scheme:dark){:root{--bg:#0F1320;--surface:#182033;--fg:#E8EBF3;--muted:#9AA3BA;--line:#34405C;--keep:#5CC4DC;--low:#E2B44C;--auto:#A79DDB;--drop:#F08A7E;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:0}h3{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:600}
.muted,.note{color:var(--muted);font-size:13px}.note{margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;margin-top:20px}
article{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:18px;min-width:0}
.kpis{display:flex;gap:24px;flex-wrap:wrap}.kpis div{display:flex;flex-direction:column}.kpis b{font-size:22px;font-variant-numeric:tabular-nums}.kpis span{color:var(--muted);font-size:13px}
.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--line)}.bar span{min-width:3px}
.c{background:var(--keep)}.l{background:var(--low)}.a{background:var(--auto)}.r{background:var(--drop)}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:13px;color:var(--muted)}.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}.legend b{color:var(--fg);font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}th{color:var(--muted);font-weight:500;text-align:left}th,td{padding:5px 8px 5px 0;border-bottom:1px solid var(--line)}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}code{font:12.5px ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
</style></head><body><main>
<h1>Operator console</h1>
<div class="muted">All enrolled projects, ${esc(windowLabel)}. Read-only. Updated ${esc(generatedAt.toISOString().replace("T", " ").slice(0, 19))} UTC, refreshes every 15 s.</div>
<div class="grid">${cards || '<p class="muted">No projects enrolled yet.</p>'}</div>
</main></body></html>`;
}
