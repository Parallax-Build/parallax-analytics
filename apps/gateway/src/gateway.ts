import type { IncomingMessage, ServerResponse } from "node:http";
import type { Classifier, TrafficClass } from "./classify.ts";
import { clientIp, truncateIp } from "./ip.ts";
import { checkWork, issueChallenge, issueToken, sha256Hex, verifyChallenge, verifyToken } from "./tokens.ts";

/** A project enrolled in Parallax. */
export interface Tenant {
  id: string;
  name: string;
  /** Umami website id. */
  websiteId: string;
  /** Hosts allowed to send events, for example `example.org` or `localhost:8090`. */
  domains: string[];
}

export type OtlpSignal = "traces" | "metrics" | "logs";

export interface ForwardedEvent {
  body: { type: "event"; payload: Record<string, unknown> };
  userAgent: string;
  /** Truncated address. The full address never leaves the gateway. */
  network: string | null;
  cache: string | undefined;
}

export interface GatewayDeps {
  secret: string;
  /** Leading zero bits the tracker must find. */
  workBits: number;
  trustProxy: boolean;
  trackerVersion: string;
  trackerSource: string;
  /** Epoch seconds. */
  now(): number;
  tenantByWebsite(websiteId: string): Tenant | undefined;
  tenantByApiKeyHash(hash: string): Tenant | undefined;
  forwardEvent(event: ForwardedEvent): Promise<{ status: number; cache: string | undefined }>;
  forwardOtlp(request: {
    signal: OtlpSignal;
    tenantId: string;
    contentType: string;
    contentEncoding: string | undefined;
    body: Buffer;
  }): Promise<{ status: number; body: Buffer; contentType: string | undefined }>;
  /** Counts one event for a tenant: its class, or `rejected` with the error code. */
  record(tenantId: string, outcome: TrafficClass | "rejected", reason: string): void;
  classifier: Classifier;
}

interface ApiError {
  status: number;
  code: string;
  message: string;
  hint: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_BODY_LIMIT = 16 * 1024;
const OTLP_BODY_LIMIT = 4 * 1024 * 1024;

function fail(status: number, code: string, message: string, hint: string): ApiError {
  return { status, code, message, hint };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = header(req, "origin");
  if (!origin) return {};
  // No credentials are ever used, so reflecting the origin grants nothing.
  // Origin binding is enforced on the request itself, not through CORS.
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(body));
}

function sendError(req: IncomingMessage, res: ServerResponse, error: ApiError): void {
  sendJson(req, res, error.status, { code: error.code, message: error.message, hint: error.hint });
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      throw fail(413, "body-too-large", `Request body is larger than ${limit} bytes.`, "Send smaller batches.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, EVENT_BODY_LIMIT);
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw fail(400, "invalid-json", "The request body is not a JSON object.", "Send a JSON object as the body.");
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Resolves the tenant for a website id and checks that the request comes from
 * one of the hosts the tenant registered.
 */
function bindOrigin(deps: GatewayDeps, req: IncomingMessage, website: unknown): { tenant: Tenant; origin: string } {
  if (typeof website !== "string" || !UUID.test(website)) {
    throw fail(400, "invalid-website", "The website id is missing or is not a UUID.", "Use the id from your Parallax dashboard.");
  }
  const tenant = deps.tenantByWebsite(website);
  if (!tenant) {
    throw fail(404, "unknown-website", "No enrolled project uses this website id.", "Check the id, or enroll the project first.");
  }
  const origin = header(req, "origin");
  let host: string | undefined;
  try {
    host = origin ? new URL(origin).host : undefined;
  } catch {
    host = undefined;
  }
  if (!origin || !host) {
    deps.record(tenant.id, "rejected", "missing-origin");
    throw fail(403, "missing-origin", "The request has no Origin header.", "Events are accepted only from a browser on a registered domain.");
  }
  if (!tenant.domains.includes(host)) {
    deps.record(tenant.id, "rejected", "origin-not-registered");
    throw fail(
      403,
      "origin-not-registered",
      `The origin ${host} is not registered for this project.`,
      "Add the domain to the project, or send events from a registered domain.",
    );
  }
  return { tenant, origin };
}

async function handleChallenge(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const { tenant, origin } = bindOrigin(deps, req, body["website"]);
  const challenge = issueChallenge(deps.secret, tenant.websiteId, origin, deps.now(), deps.workBits);
  sendJson(req, res, 200, { challenge, bits: deps.workBits });
}

async function handleToken(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const verified = verifyChallenge(deps.secret, body["challenge"], deps.now());
  if (!verified.ok) {
    throw fail(401, `challenge-${verified.reason}`, "The challenge is not valid.", "Request a new challenge and try again.");
  }
  const { tenant, origin } = bindOrigin(deps, req, verified.payload.w);
  if (origin !== verified.payload.o) {
    deps.record(tenant.id, "rejected", "challenge-origin-mismatch");
    throw fail(403, "challenge-origin-mismatch", "The challenge was issued to another origin.", "Request a challenge from this origin.");
  }
  const counter = body["counter"];
  if (typeof counter !== "number" || !checkWork(body["challenge"] as string, counter, verified.payload.bits)) {
    deps.record(tenant.id, "rejected", "challenge-not-solved");
    throw fail(403, "challenge-not-solved", "The answer to the challenge is wrong.", "Run the computation the tracker runs, then send the counter.");
  }
  const ttl = 1800;
  const token = issueToken(deps.secret, tenant.websiteId, origin, deps.now(), ttl);
  sendJson(req, res, 200, { token, expiresIn: ttl });
}

async function handleEvent(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const input = body["payload"];
  if (body["type"] !== "event" || input === null || typeof input !== "object" || Array.isArray(input)) {
    throw fail(400, "invalid-event", "The body must be { type: \"event\", payload: { ... } }.", "Use the Parallax tracker, or follow its format.");
  }
  const payloadIn = input as Record<string, unknown>;
  const { tenant, origin } = bindOrigin(deps, req, payloadIn["website"]);

  const verified = verifyToken(deps.secret, body["token"], deps.now());
  if (!verified.ok) {
    const code = body["token"] === undefined ? "missing-token" : `token-${verified.reason}`;
    deps.record(tenant.id, "rejected", code);
    throw fail(401, code, "The event has no valid browser token.", "Request a challenge, solve it, and send the token with each event.");
  }
  if (verified.payload.w !== tenant.websiteId || verified.payload.o !== origin) {
    deps.record(tenant.id, "rejected", "token-scope-mismatch");
    throw fail(403, "token-scope-mismatch", "The token was issued for another website or origin.", "Request a token from this origin for this website.");
  }

  const originHost = new URL(origin).hostname;
  const hostname = optionalString(payloadIn["hostname"], 255) ?? originHost;
  if (hostname !== originHost) {
    deps.record(tenant.id, "rejected", "hostname-mismatch");
    throw fail(403, "hostname-mismatch", "The event hostname does not match the request origin.", "Send the hostname of the page that produced the event.");
  }

  const userAgent = header(req, "user-agent");
  const network = truncateIp(clientIp(req.headers, req.socket.remoteAddress, deps.trustProxy));
  const classification = deps.classifier.classify({
    userAgent,
    webdriver: body["wd"] === true,
    hasFetchMetadata: header(req, "sec-fetch-site") !== undefined,
    website: tenant.websiteId,
    network,
    now: deps.now(),
  });
  deps.record(tenant.id, classification.class, classification.reason);

  let cache: string | undefined;
  if (classification.class !== "automated") {
    // Whitelist: a client can never set its own address or user agent upstream.
    const payload: Record<string, unknown> = { website: tenant.websiteId, hostname };
    for (const [key, max] of [["url", 2000], ["referrer", 2000], ["title", 500], ["screen", 32], ["language", 35], ["name", 50]] as const) {
      const value = optionalString(payloadIn[key], max);
      if (value !== undefined) payload[key] = value;
    }
    const data = payloadIn["data"];
    if (data !== null && typeof data === "object" && !Array.isArray(data)) payload["data"] = data;

    const upstream = await deps.forwardEvent({
      body: { type: "event", payload },
      userAgent: userAgent as string,
      network,
      cache: optionalString(body["cache"], 2048),
    });
    if (upstream.status >= 500) {
      throw fail(502, "upstream-unavailable", "The analytics store did not accept the event.", "Retry in a few seconds.");
    }
    if (upstream.status >= 400) {
      throw fail(400, "invalid-event", "The analytics store rejected the event.", "Check the url, referrer and data fields.");
    }
    cache = upstream.cache;
  }
  sendJson(req, res, 202, { ok: true, class: classification.class, cache });
}

async function handleOtlp(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse, signal: OtlpSignal): Promise<void> {
  const auth = header(req, "authorization");
  const key = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
  const tenant = key ? deps.tenantByApiKeyHash(sha256Hex(key)) : undefined;
  if (!tenant) {
    throw fail(401, "invalid-api-key", "The API key is missing or unknown.", "Send `Authorization: Bearer <key>` with the key issued to your project.");
  }
  const body = await readBody(req, OTLP_BODY_LIMIT);
  // The tenant id comes from the key, never from the payload, so a project
  // cannot write as another one.
  const upstream = await deps.forwardOtlp({
    signal,
    tenantId: tenant.id,
    contentType: header(req, "content-type") ?? "application/x-protobuf",
    contentEncoding: header(req, "content-encoding"),
    body,
  });
  res.writeHead(upstream.status, { "content-type": upstream.contentType ?? "application/json" });
  res.end(upstream.body);
}

/** Builds the HTTP request handler for the ingest gateway. */
export function createGateway(deps: GatewayDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const trackerPath = `/v/${deps.trackerVersion}/parallax.js`;

  return (req, res) => {
    void (async () => {
      try {
        const path = (req.url ?? "/").split("?")[0] as string;

        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders(req));
          res.end();
          return;
        }
        if (req.method === "GET" && path === "/healthz") {
          sendJson(req, res, 200, { ok: true });
          return;
        }
        if (req.method === "GET" && path === trackerPath) {
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            // The URL carries the version, so the content can never change.
            "cache-control": "public, max-age=31536000, immutable",
            "access-control-allow-origin": "*",
            "cross-origin-resource-policy": "cross-origin",
          });
          res.end(deps.trackerSource);
          return;
        }
        if (req.method === "POST" && path === "/challenge") return await handleChallenge(deps, req, res);
        if (req.method === "POST" && path === "/token") return await handleToken(deps, req, res);
        if (req.method === "POST" && path === "/e") return await handleEvent(deps, req, res);
        const otlp = /^\/otlp\/v1\/(traces|metrics|logs)$/.exec(path);
        if (req.method === "POST" && otlp) return await handleOtlp(deps, req, res, otlp[1] as OtlpSignal);

        throw fail(404, "not-found", "No such endpoint.", "See the README for the list of endpoints.");
      } catch (error) {
        if (isApiError(error)) {
          sendError(req, res, error);
          return;
        }
        console.error(JSON.stringify({ level: "error", msg: "unhandled", error: String(error) }));
        if (!res.headersSent) {
          sendError(req, res, fail(500, "internal-error", "Unexpected error.", "Retry; if it persists, open an issue."));
        } else {
          res.end();
        }
      }
    })();
  };
}
