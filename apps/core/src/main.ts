import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pg from "pg";
import { renderOperatorPage } from "./operator.ts";
import { parseSpanMetrics } from "./otlp.ts";
import { renderLanding, renderMap } from "./pages.ts";
import { ApiWriter, migrate, projectSummaries, tenantApiRoutes } from "./store.ts";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    console.error(JSON.stringify({ level: "fatal", msg: `missing environment variable ${name}` }));
    process.exit(1);
  }
  return value;
}

const internalKey = env("PARALLAX_INTERNAL_KEY");
const operatorKey = env("PARALLAX_OPERATOR_KEY");
const operatorPublic = env("PARALLAX_OPERATOR_PUBLIC", "false") === "true";
const port = Number(env("PORT", "8081"));
const ingestUrl = env("PARALLAX_PUBLIC_INGEST_URL", "http://localhost:8080").replace(/\/$/, "");
const dashboardUrl = env("PARALLAX_PUBLIC_DASHBOARD_URL", "http://localhost:3000").replace(/\/$/, "");
const apiDemoUrl = env("PARALLAX_PUBLIC_API_DEMO_URL", "http://localhost:8091").replace(/\/$/, "");
const pool = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 6 });
const writer = new ApiWriter(pool);

function same(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearer(req: IncomingMessage): string | undefined {
  const auth = header(req, "authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, code: string, message: string, hint: string): void {
  json(res, status, { code, message, hint });
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function windowFrom(url: URL): { since: Date; label: string } {
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? "7") || 7, 1), 90);
  return { since: new Date(Date.now() - days * 86400000), label: days === 1 ? "last 24 hours" : `last ${days} days` };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://core");
  const path = url.pathname;

  if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });

  // Collector -> writer. Internal network only, plus a shared key.
  if (req.method === "POST" && path === "/internal/otlp/v1/metrics") {
    if (!same(header(req, "x-internal-key"), internalKey)) {
      return error(res, 401, "invalid-internal-key", "Unknown caller.", "Only the Parallax Collector may call this endpoint.");
    }
    const body = await readBody(req, 8 * 1024 * 1024);
    if (!body) return error(res, 413, "body-too-large", "Payload too large.", "Lower the Collector batch size.");
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return error(res, 400, "invalid-json", "Body is not JSON.", "Set `encoding: json` on the Collector exporter.");
    }
    const { rows, skipped } = parseSpanMetrics(payload);
    const result = await writer.write(rows);
    if (Object.keys(skipped).length > 0 || result.collapsed > 0 || result.unknownTenant > 0) {
      console.log(JSON.stringify({ level: "warn", msg: "api metrics partially stored", skipped, ...result }));
    }
    return json(res, 200, {});
  }

  // Operator console (HTML) and operator API (JSON).
  if (req.method === "GET" && (path === "/operator" || path === "/api/v1/projects")) {
    const authorized = operatorPublic || same(bearer(req), operatorKey);
    if (!authorized) {
      return error(res, 401, "invalid-operator-key", "Operator key required.", "Send `Authorization: Bearer <operator key>`.");
    }
    const { since, label } = windowFrom(url);
    const projects = await projectSummaries(pool, since);
    if (path === "/api/v1/projects") return json(res, 200, { window: label, since: since.toISOString(), projects });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderOperatorPage(projects, label, new Date()));
    return;
  }

  // Tenant API: a project reads its own API routes with its own key.
  if (req.method === "GET" && path === "/api/v1/me/routes") {
    const key = bearer(req);
    const hash = key ? createHash("sha256").update(key).digest("hex") : "";
    const tenant = await pool.query<{ id: string }>("select id from parallax.tenant where api_key_hash = $1 and enabled", [hash]);
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) {
      return error(res, 401, "invalid-api-key", "The API key is missing or unknown.", "Send `Authorization: Bearer <key>` with your project key.");
    }
    const { since, label } = windowFrom(url);
    return json(res, 200, { tenant: tenantId, window: label, routes: await tenantApiRoutes(pool, tenantId, since) });
  }

  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(await renderLanding(pool, { ingestUrl, apiDemoUrl, dashboardUrl }));
    return;
  }
  if (req.method === "GET" && path === "/map") {
    const page = renderMap();
    if (!page) return error(res, 404, "not-found", "The infrastructure map is not bundled.", "See docs/infrastructure-map.html in the repository.");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
    res.end(page);
    return;
  }
  return error(res, 404, "not-found", "No such endpoint.", "See the README for the list of endpoints.");
}

async function start(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(pool);
      break;
    } catch (e) {
      if (attempt >= 30) throw e;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error(JSON.stringify({ level: "error", msg: "unhandled", error: String(e) }));
      if (!res.headersSent) error(res, 500, "internal-error", "Unexpected error.", "Retry; if it persists, open an issue.");
      else res.end();
    });
  }).listen(port, () => {
    console.log(JSON.stringify({ level: "info", msg: "core listening", port, operatorPublic }));
  });
}

void start();
