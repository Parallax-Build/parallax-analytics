import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";

/** Landing page and infrastructure map, served by the core service. */

const TRACKER_VERSION = "0.1.0";
const template = readFileSync(new URL("./pages/landing.html", import.meta.url), "utf8");
const tracker = readFileSync(new URL("../../gateway/src/tracker/parallax.js", import.meta.url));
const integrity = `sha384-${createHash("sha384").update(tracker).digest("base64")}`;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** `example.org` -> `https://example.org`; local hosts stay on http. */
function originOf(host: string | undefined, fallback: string): string {
  if (!host) return fallback;
  return /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? `http://${host}` : `https://${host}`;
}

interface LandingConfig {
  ingestUrl: string;
  apiDemoUrl: string;
}

let cached: { html: string; at: number } | undefined;

export async function renderLanding(pool: pg.Pool, config: LandingConfig): Promise<string> {
  if (cached && Date.now() - cached.at < 30000) return cached.html;
  const tenants = await pool.query<{ id: string; website_id: string; domains: string[] }>(
    "select id, website_id, domains from parallax.tenant where enabled and id in ('demo-wallet', 'demo-explorer', 'parallax')",
  );
  const find = (id: string) => tenants.rows.find((t) => t.id === id);
  const wallet = find("demo-wallet");
  const explorer = find("demo-explorer");
  const self = find("parallax");

  // The landing page is itself a Parallax tenant, when one is enrolled for it.
  const trackerTag = self
    ? `<script defer src="${esc(config.ingestUrl)}/v/${TRACKER_VERSION}/parallax.js" data-website="${esc(self.website_id)}" integrity="${integrity}" crossorigin="anonymous"></script>`
    : "";

  const values: Record<string, string> = {
    TRACKER_TAG: trackerTag,
    INGEST: esc(config.ingestUrl),
    API_DEMO: esc(config.apiDemoUrl),
    DEMO_ORIGIN: esc(originOf(wallet?.domains[0], "http://localhost:8090")),
    EXPLORER_ORIGIN: esc(originOf(explorer?.domains[0], "http://localhost:8092")),
    DEMO_WEBSITE: esc(wallet?.website_id ?? "WEBSITE_ID"),
  };
  const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
  cached = { html, at: Date.now() };
  return html;
}

let mapPage: string | undefined;

/** The trilingual infrastructure map from `docs/`, wrapped as a full document. */
export function renderMap(): string | null {
  if (mapPage === undefined) {
    try {
      const body = readFileSync(new URL("../../../docs/infrastructure-map.html", import.meta.url), "utf8");
      mapPage = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>\n${body}\n</body></html>`;
    } catch {
      return null;
    }
  }
  return mapPage;
}
