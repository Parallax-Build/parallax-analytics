/**
 * End-to-end smoke test against a running stack started with
 * `docker compose --profile demo up -d --build`.
 *
 *   node --env-file=.env scripts/smoke.ts
 *
 * It writes test traffic, so run it against a throwaway stack (CI does).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { solveWork } from "../apps/gateway/src/tokens.ts";

const GATEWAY = process.env["SMOKE_GATEWAY_URL"] ?? "http://localhost:8080";
const CORE = process.env["SMOKE_CORE_URL"] ?? "http://localhost:8081";
const EDGE = process.env["SMOKE_EDGE_URL"] ?? "http://localhost:3000";
const API = process.env["SMOKE_API_URL"] ?? "http://localhost:8091";
const ORIGIN = "http://localhost:8090";
const operatorKey = process.env["PARALLAX_OPERATOR_KEY"] ?? "";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

interface Project {
  id: string;
  web: { pageviews: number };
  traffic: { confident: number; rejected: number };
  api: { calls: number; routes: { route: string; calls: number }[] } | null;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "text/plain", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

async function projects(): Promise<Project[]> {
  const response = await fetch(`${CORE}/api/v1/projects?days=1`, { headers: { authorization: `Bearer ${operatorKey}` } });
  assert.equal(response.status, 200, "operator API should answer");
  return ((await response.json()) as { projects: Project[] }).projects;
}

function step(name: string): void {
  console.log(`ok  ${name}`);
}

function base32(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return [...randomBytes(length)].map((b) => alphabet[b % 32]).join("");
}

async function main(): Promise<void> {
  const before = await projects();
  const wallet = before.find((p) => p.id === "demo-wallet");
  assert.ok(wallet, "demo-wallet should be enrolled");

  // The website id is public (it is in the page source), like any analytics id.
  const html = await (await fetch(ORIGIN)).text();
  const website = /data-website="([0-9a-f-]{36})"/.exec(html)?.[1];
  assert.ok(website, "demo site should embed a website id");
  assert.match(html, /integrity="sha384-/, "tracker tag should carry an integrity hash");
  step("demo site embeds the pinned tracker with an integrity hash");

  const event = { type: "event", payload: { website, hostname: "localhost", url: "/smoke", title: "Smoke" } };

  let reply = await post(`${GATEWAY}/e`, event);
  assert.equal(reply.status, 403);
  assert.equal(reply.body["code"], "missing-origin");
  step("server-side POST with no Origin is rejected");

  reply = await post(`${GATEWAY}/e`, event, { origin: ORIGIN });
  assert.equal(reply.status, 401);
  assert.equal(reply.body["code"], "missing-token");
  step("POST with a forged Origin but no token is rejected");

  reply = await post(`${GATEWAY}/challenge`, { website }, { origin: "https://evil.example" });
  assert.equal(reply.status, 403);
  assert.equal(reply.body["code"], "origin-not-registered");
  step("an unregistered origin cannot even get a challenge");

  reply = await post(`${EDGE}/api/send`, event, { "content-type": "application/json" });
  assert.equal(reply.status, 403);
  assert.equal(reply.body["code"], "direct-collection-disabled");
  step("Umami's own collection endpoint is closed");

  // A client that does everything the tracker does is accepted. This is the
  // stated limit of the design: the token raises cost, it does not prove a human.
  const browser = { origin: ORIGIN, "user-agent": UA, "sec-fetch-site": "cross-site" };
  const challenge = await post(`${GATEWAY}/challenge`, { website }, browser);
  assert.equal(challenge.status, 200);
  const counter = solveWork(challenge.body["challenge"] as string, challenge.body["bits"] as number);
  const token = await post(`${GATEWAY}/token`, { challenge: challenge.body["challenge"], counter }, browser);
  assert.equal(token.status, 200);
  reply = await post(`${GATEWAY}/e`, { ...event, token: token.body["token"] }, browser);
  assert.equal(reply.status, 202);
  assert.equal(reply.body["class"], "confident");
  step("an event with a solved token from a registered origin is accepted");

  reply = await post(`${GATEWAY}/e`, { ...event, token: token.body["token"] }, { ...browser, "user-agent": "python-requests/2.32" });
  assert.equal(reply.status, 202);
  assert.equal(reply.body["class"], "automated");
  step("declared automation is counted as automated, not as a visit");

  // API traffic with random Stellar-shaped identifiers.
  const accounts: string[] = [];
  for (let i = 0; i < 12; i++) {
    const account = `G${base32(55)}`;
    accounts.push(account);
    await fetch(`${API}/accounts/${account}`);
    await fetch(`${API}/accounts/${account}/payments?limit=5`);
    await fetch(`${API}/transactions/${randomBytes(32).toString("hex")}`);
  }
  step("sent 36 API requests with 12 distinct accounts and 12 distinct hashes");

  const deadline = Date.now() + 60000;
  let after: Project | undefined;
  for (;;) {
    after = (await projects()).find((p) => p.id === "demo-wallet");
    const grew = (after?.api?.calls ?? 0) >= (wallet.api?.calls ?? 0) + 36;
    if (grew && (after?.traffic.rejected ?? 0) >= wallet.traffic.rejected + 3) break;
    assert.ok(Date.now() < deadline, "aggregates did not arrive within 60 s");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  assert.ok(after?.api);
  const routes = after.api.routes.map((r) => r.route);
  for (const expected of ["/accounts/{account}", "/accounts/{account}/payments", "/transactions/{hash}"]) {
    assert.ok(routes.includes(expected), `route ${expected} should exist`);
  }
  const dump = JSON.stringify(after);
  for (const account of accounts) assert.ok(!dump.includes(account), "a raw Stellar address reached storage");
  assert.ok(routes.length <= 10, `expected a handful of routes, got ${routes.length}`);
  step(`API requests are stored as ${routes.length} normalized routes; no Stellar address is stored`);

  const blocked = await fetch(`${CORE}/api/v1/projects`, { headers: { authorization: "Bearer wrong" } });
  if (process.env["PARALLAX_OPERATOR_PUBLIC"] !== "true") assert.equal(blocked.status, 401);
  step("operator API answers");

  console.log("\nsmoke test passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
