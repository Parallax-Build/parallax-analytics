/**
 * Load test for the API analytics path: gateway -> Collector -> writer -> PostgreSQL.
 *
 *   node apps/core/src/loadtest.ts <ingest-url> <api-key> <spans-per-second> <seconds>
 *
 * Sends OTLP/JSON server spans with random Stellar-shaped paths at a fixed
 * rate and reports what was sent. Compare with `sum(calls)` in
 * `parallax.api_minute` for the tenant to check that nothing was lost.
 */
import { randomBytes } from "node:crypto";

const [url, key, rateArg, secondsArg] = process.argv.slice(2);
if (!url || !key) {
  console.error("usage: loadtest.ts <ingest-url> <api-key> [spans-per-second=200] [seconds=60]");
  process.exit(1);
}
const rate = Number(rateArg ?? "200");
const seconds = Number(secondsArg ?? "60");
const TICK_MS = 100;
const perTick = Math.max(1, Math.round((rate * TICK_MS) / 1000));

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const account = (): string => `G${[...randomBytes(55)].map((b) => ALPHABET[b % 32]).join("")}`;
const hash = (): string => randomBytes(32).toString("hex");

const SHAPES: (() => string)[] = [
  () => `/accounts/${account()}`,
  () => `/accounts/${account()}/payments?limit=10`,
  () => `/transactions/${hash()}`,
  () => `/ledgers/${50_000_000 + Math.floor(Math.random() * 1_000_000)}`,
  () => `/contracts/C${account().slice(1)}/events`,
];

function span(nowMs: number): unknown {
  const durationMs = 2 + Math.random() * 180;
  const start = BigInt(Math.floor(nowMs - durationMs)) * 1_000_000n;
  const end = BigInt(Math.floor(nowMs)) * 1_000_000n;
  const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)] as () => string;
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    name: "GET",
    kind: 2, // SPAN_KIND_SERVER
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    attributes: [
      { key: "http.request.method", value: { stringValue: "GET" } },
      { key: "url.path", value: { stringValue: shape() } },
      { key: "http.response.status_code", value: { intValue: Math.random() < 0.02 ? "503" : "200" } },
      // Extra attributes a real service would send. None of this may be stored.
      { key: "user.id", value: { stringValue: `user-${randomBytes(4).toString("hex")}` } },
      { key: "client.address", value: { stringValue: "203.0.113.7" } },
    ],
  };
}

let sent = 0;
let failed = 0;
const latencies: number[] = [];
const pending = new Set<Promise<void>>();

async function tick(): Promise<void> {
  const now = Date.now();
  const spans = Array.from({ length: perTick }, () => span(now));
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "loadtest-api" } }] },
        scopeSpans: [{ spans }],
      },
    ],
  });
  const started = performance.now();
  try {
    const response = await fetch(`${url}/otlp/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(15000),
    });
    await response.arrayBuffer();
    if (response.ok) sent += spans.length;
    else failed += spans.length;
  } catch {
    failed += spans.length;
  }
  latencies.push(performance.now() - started);
}

const startedAt = Date.now();
const totalTicks = Math.round((seconds * 1000) / TICK_MS);
for (let i = 0; i < totalTicks; i++) {
  const due = startedAt + i * TICK_MS;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const p = tick().finally(() => pending.delete(p));
  pending.add(p);
}
await Promise.all(pending);

latencies.sort((a, b) => a - b);
const q = (p: number): number => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ?? 0);
const elapsed = (Date.now() - startedAt) / 1000;
console.log(
  JSON.stringify({
    targetSpansPerSecond: rate,
    seconds: Math.round(elapsed),
    sent,
    failed,
    achievedSpansPerSecond: Math.round(sent / elapsed),
    perDayAtThisRate: Math.round((sent / elapsed) * 86400),
    requestLatencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99) },
  }),
);
