import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import pg from "pg";
import { Classifier } from "./classify.ts";
import { createGateway, type Tenant } from "./gateway.ts";

const TRACKER_VERSION = "0.1.0";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    console.error(JSON.stringify({ level: "fatal", msg: `missing environment variable ${name}` }));
    process.exit(1);
  }
  return value;
}

const secret = env("PARALLAX_TOKEN_SECRET");
if (secret.length < 32) {
  console.error(JSON.stringify({ level: "fatal", msg: "PARALLAX_TOKEN_SECRET must be at least 32 characters" }));
  process.exit(1);
}
const umamiUrl = env("UMAMI_URL", "http://umami:3000").replace(/\/$/, "");
const collectorUrl = env("COLLECTOR_URL", "http://collector:4318").replace(/\/$/, "");
const port = Number(env("PORT", "8080"));

const pool = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 4 });

// --- tenant registry, refreshed from PostgreSQL -----------------------------

let byWebsite = new Map<string, Tenant>();
let byKeyHash = new Map<string, Tenant>();

async function loadTenants(): Promise<void> {
  const result = await pool.query<{ id: string; name: string; website_id: string; domains: string[]; api_key_hash: string | null }>(
    "select id, name, website_id, domains, api_key_hash from parallax.tenant where enabled",
  );
  const websites = new Map<string, Tenant>();
  const keys = new Map<string, Tenant>();
  for (const row of result.rows) {
    const tenant: Tenant = { id: row.id, name: row.name, websiteId: row.website_id, domains: row.domains };
    websites.set(row.website_id, tenant);
    if (row.api_key_hash) keys.set(row.api_key_hash, tenant);
  }
  byWebsite = websites;
  byKeyHash = keys;
}

// --- per-minute counters, flushed in batches --------------------------------

const counters = new Map<string, number>();

function record(tenantId: string, outcome: string, reason: string): void {
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  const key = JSON.stringify([tenantId, minute, outcome, reason]);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

async function flushCounters(): Promise<void> {
  if (counters.size === 0) return;
  const batch = [...counters.entries()];
  counters.clear();
  for (const [key, events] of batch) {
    const [tenantId, minute, outcome, reason] = JSON.parse(key) as [string, string, string, string];
    await pool.query(
      `insert into parallax.ingest_minute (tenant_id, minute, class, reason, events)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, minute, class, reason)
       do update set events = parallax.ingest_minute.events + excluded.events`,
      [tenantId, minute, outcome, reason, events],
    );
  }
}

// --- server -----------------------------------------------------------------

const classifier = new Classifier();

const handler = createGateway({
  secret,
  workBits: Number(env("PARALLAX_WORK_BITS", "12")),
  trustProxy: env("TRUST_PROXY", "false") === "true",
  trackerVersion: TRACKER_VERSION,
  trackerSource: readFileSync(new URL("./tracker/parallax.js", import.meta.url), "utf8"),
  now: () => Math.floor(Date.now() / 1000),
  tenantByWebsite: (id) => byWebsite.get(id),
  tenantByApiKeyHash: (hash) => byKeyHash.get(hash),
  record,
  classifier,
  async forwardEvent(event) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": event.userAgent,
    };
    // Only the truncated address goes upstream.
    if (event.network) headers["x-forwarded-for"] = event.network;
    if (event.cache) headers["x-umami-cache"] = event.cache;
    const response = await fetch(`${umamiUrl}/api/send`, {
      method: "POST",
      headers,
      body: JSON.stringify(event.body),
      signal: AbortSignal.timeout(5000),
    });
    let cache: string | undefined;
    try {
      const body = (await response.json()) as { cache?: unknown };
      if (typeof body.cache === "string") cache = body.cache;
    } catch {
      cache = undefined;
    }
    return { status: response.status, cache };
  },
  async forwardOtlp(request) {
    const headers: Record<string, string> = {
      "content-type": request.contentType,
      "x-parallax-tenant": request.tenantId,
    };
    if (request.contentEncoding) headers["content-encoding"] = request.contentEncoding;
    const response = await fetch(`${collectorUrl}/v1/${request.signal}`, {
      method: "POST",
      headers,
      body: new Uint8Array(request.body),
      signal: AbortSignal.timeout(10000),
    });
    return {
      status: response.status,
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  },
});

async function start(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await loadTenants();
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  setInterval(() => void loadTenants().catch((e) => console.error(JSON.stringify({ level: "error", msg: "tenant refresh failed", error: String(e) }))), 15000);
  setInterval(() => void flushCounters().catch((e) => console.error(JSON.stringify({ level: "error", msg: "counter flush failed", error: String(e) }))), 5000);
  setInterval(() => classifier.prune(Math.floor(Date.now() / 1000)), 600000);

  createServer(handler).listen(port, () => {
    console.log(JSON.stringify({ level: "info", msg: "gateway listening", port, tracker: `/v/${TRACKER_VERSION}/parallax.js` }));
  });
}

void start();
