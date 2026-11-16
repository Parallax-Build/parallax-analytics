import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Classifier } from "./classify.ts";
import { createGateway, type ForwardedEvent, type Tenant } from "./gateway.ts";
import { sha256Hex, solveWork } from "./tokens.ts";

const WEBSITE = "11111111-2222-4333-8444-555555555555";
const ORIGIN = "https://shop.example.org";
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const API_KEY = "plx_test_key";

const tenant: Tenant = { id: "shop", name: "Shop", websiteId: WEBSITE, domains: ["shop.example.org"] };

let server: Server;
let base: string;
let forwarded: ForwardedEvent[];
let otlp: { tenantId: string; signal: string }[];
let records: string[];
let now: number;

beforeEach(async () => {
  forwarded = [];
  otlp = [];
  records = [];
  now = 1_800_000_000;
  const handler = createGateway({
    secret: "test-secret-test-secret-test-secret-1234",
    workBits: 8,
    trustProxy: true,
    trackerVersion: "0.1.0",
    trackerSource: "/* tracker */",
    now: () => now,
    tenantByWebsite: (id) => (id === WEBSITE ? tenant : undefined),
    tenantByApiKeyHash: (hash) => (hash === sha256Hex(API_KEY) ? tenant : undefined),
    classifier: new Classifier(),
    record: (id, outcome, reason) => records.push(`${id}:${outcome}:${reason}`),
    async forwardEvent(event) {
      forwarded.push(event);
      return { status: 200, cache: "cache-value" };
    },
    async forwardOtlp(request) {
      otlp.push({ tenantId: request.tenantId, signal: request.signal });
      return { status: 200, body: Buffer.from("{}"), contentType: "application/json" };
    },
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "text/plain", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const browser = { origin: ORIGIN, "user-agent": BROWSER_UA, "sec-fetch-site": "cross-site", "x-forwarded-for": "203.0.113.77" };

async function getToken(headers: Record<string, string> = browser): Promise<string> {
  const challenge = await post("/challenge", { website: WEBSITE }, headers);
  expect(challenge.status).toBe(200);
  const value = challenge.body["challenge"] as string;
  const counter = solveWork(value, challenge.body["bits"] as number);
  const token = await post("/token", { challenge: value, counter }, headers);
  expect(token.status).toBe(200);
  return token.body["token"] as string;
}

function event(token: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "event",
    token,
    payload: { website: WEBSITE, hostname: "shop.example.org", url: "/products", title: "Products", ...extra },
  };
}

describe("event ingestion", () => {
  it("accepts an event from a registered origin with a solved token", async () => {
    const token = await getToken();
    const reply = await post("/e", event(token), browser);
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ ok: true, class: "confident", cache: "cache-value" });
    expect(forwarded).toHaveLength(1);
    expect(records).toContain("shop:confident:ok");
  });

  it("forwards only the truncated address", async () => {
    const token = await getToken();
    await post("/e", event(token), browser);
    expect(forwarded[0]?.network).toBe("203.0.113.0");
    expect(JSON.stringify(forwarded[0])).not.toContain("203.0.113.77");
  });

  it("never forwards client-supplied ip or userAgent overrides", async () => {
    const token = await getToken();
    await post("/e", event(token, { ip: "8.8.8.8", userAgent: "Forged/1.0", id: "user-42" }), browser);
    const payload = forwarded[0]?.body.payload ?? {};
    expect(payload).not.toHaveProperty("ip");
    expect(payload).not.toHaveProperty("userAgent");
    expect(payload).not.toHaveProperty("id");
  });

  it("rejects a server-side POST with no token", async () => {
    const reply = await post("/e", event(undefined), browser);
    expect(reply.status).toBe(401);
    expect(reply.body).toMatchObject({ code: "missing-token" });
    expect(reply.body["hint"]).toBeTypeOf("string");
    expect(forwarded).toHaveLength(0);
    expect(records).toContain("shop:rejected:missing-token");
  });

  it("rejects a request with no Origin header", async () => {
    const reply = await post("/e", event("t.x.y"), { "user-agent": "curl/8.5.0" });
    expect(reply.status).toBe(403);
    expect(reply.body).toMatchObject({ code: "missing-origin" });
  });

  it("rejects an origin the tenant did not register", async () => {
    const reply = await post("/challenge", { website: WEBSITE }, { ...browser, origin: "https://evil.example.com" });
    expect(reply.status).toBe(403);
    expect(reply.body).toMatchObject({ code: "origin-not-registered" });
    expect(records).toContain("shop:rejected:origin-not-registered");
  });

  it("rejects a forged token", async () => {
    const token = await getToken();
    const forged = `${token.slice(0, -4)}AAAA`;
    const reply = await post("/e", event(forged), browser);
    expect(reply.status).toBe(401);
    expect(reply.body).toMatchObject({ code: "token-bad-signature" });
  });

  it("rejects an expired token", async () => {
    const token = await getToken();
    now += 1801;
    const reply = await post("/e", event(token), browser);
    expect(reply.status).toBe(401);
    expect(reply.body).toMatchObject({ code: "token-expired" });
  });

  it("rejects a wrong answer to the challenge", async () => {
    const challenge = await post("/challenge", { website: WEBSITE }, browser);
    const value = challenge.body["challenge"] as string;
    const reply = await post("/token", { challenge: value, counter: -1 }, browser);
    expect(reply.status).toBe(403);
    expect(reply.body).toMatchObject({ code: "challenge-not-solved" });
  });

  it("rejects an event whose hostname is not the origin", async () => {
    const token = await getToken();
    const reply = await post("/e", event(token, { hostname: "other.example.org" }), browser);
    expect(reply.status).toBe(403);
    expect(reply.body).toMatchObject({ code: "hostname-mismatch" });
  });

  it("rejects an unknown website id", async () => {
    const reply = await post("/challenge", { website: "99999999-2222-4333-8444-555555555555" }, browser);
    expect(reply.status).toBe(404);
    expect(reply.body).toMatchObject({ code: "unknown-website" });
  });

  it("counts automated traffic but does not forward it", async () => {
    const headless = { ...browser, "user-agent": "Mozilla/5.0 HeadlessChrome/130.0" };
    const token = await getToken(headless);
    const reply = await post("/e", event(token), headless);
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ class: "automated" });
    expect(forwarded).toHaveLength(0);
    expect(records).toContain("shop:automated:automation-user-agent");
  });

  it("classifies a browser that declares automation", async () => {
    const token = await getToken();
    const reply = await post("/e", { ...event(token), wd: true }, browser);
    expect(reply.body).toMatchObject({ class: "automated" });
    expect(records).toContain("shop:automated:webdriver");
  });

  it("keeps a burst from one network but marks it low confidence", async () => {
    const token = await getToken();
    let last: Reply | undefined;
    for (let i = 0; i < 61; i++) last = await post("/e", event(token, { url: `/p/${i}` }), browser);
    expect(last?.body).toMatchObject({ class: "low_confidence" });
    expect(forwarded).toHaveLength(61);
    expect(records).toContain("shop:low_confidence:rate");
  });
});

describe("tracker", () => {
  it("is served only at its versioned URL, as immutable", async () => {
    const ok = await fetch(`${base}/v/0.1.0/parallax.js`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${base}/v/latest/parallax.js`)).status).toBe(404);
    expect((await fetch(`${base}/parallax.js`)).status).toBe(404);
  });
});

describe("OTLP ingestion", () => {
  it("takes the tenant from the API key", async () => {
    const response = await fetch(`${base}/otlp/v1/traces`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", "x-parallax-tenant": "someone-else" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(otlp).toEqual([{ tenantId: "shop", signal: "traces" }]);
  });

  it("rejects a missing or unknown key", async () => {
    const response = await fetch(`${base}/otlp/v1/traces`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid-api-key" });
    expect(otlp).toHaveLength(0);
  });
});
