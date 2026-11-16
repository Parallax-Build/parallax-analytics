import { describe, expect, it } from "vitest";
import { parseSpanMetrics, percentile } from "./otlp.ts";

const G = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const T0 = 1_800_000_000_000; // ms, on a minute boundary + 0s

function point(route: string, status: string, count: number, timeMs = T0 + 5000): unknown {
  return {
    attributes: [
      { key: "parallax.route", value: { stringValue: route } },
      { key: "parallax.status", value: { intValue: status } },
      { key: "parallax.method", value: { stringValue: "get" } },
    ],
    timeUnixNano: `${timeMs}000000`,
    count: String(count),
    sum: 120.5,
    bucketCounts: [String(count), "0", "0"],
    explicitBounds: [10, 100],
  };
}

function payload(points: unknown[], tenant: string | null = "demo-wallet", temporality: unknown = 1): unknown {
  const resourceAttributes = [{ key: "service.name", value: { stringValue: "horizon" } }];
  if (tenant) resourceAttributes.push({ key: "parallax.tenant", value: { stringValue: tenant } });
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes },
        scopeMetrics: [
          {
            metrics: [
              { name: "traces.span.metrics.calls", sum: { dataPoints: [{ asInt: "5" }] } },
              { name: "traces.span.metrics.duration", histogram: { aggregationTemporality: temporality, dataPoints: points } },
            ],
          },
        ],
      },
    ],
  };
}

describe("parseSpanMetrics", () => {
  it("turns a duration histogram into a per-minute row", () => {
    const { rows, skipped } = parseSpanMetrics(payload([point("/accounts/{account}", "200", 3)]));
    expect(skipped).toEqual({});
    expect(rows).toEqual([
      {
        tenantId: "demo-wallet",
        service: "horizon",
        method: "GET",
        route: "/accounts/{account}",
        status: 200,
        minute: new Date(T0).toISOString(),
        calls: 3,
        durationMsSum: 120.5,
        bucketBoundsMs: [10, 100],
        bucketCounts: [3, 0, 0],
      },
    ]);
  });

  it("normalizes again, so a raw Stellar address can never be stored", () => {
    const { rows } = parseSpanMetrics(payload([point(`/accounts/${G}/payments?cursor=1`, "200", 1)]));
    expect(rows[0]?.route).toBe("/accounts/{account}/payments");
    expect(JSON.stringify(rows)).not.toContain(G);
  });

  it("merges points that land on the same route and minute", () => {
    const { rows } = parseSpanMetrics(
      payload([point(`/accounts/${G}`, "200", 2), point("/accounts/{account}", "200", 5, T0 + 30000), point("/accounts/{account}", "500", 1)]),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.status === 200)).toMatchObject({ calls: 7, bucketCounts: [7, 0, 0] });
  });

  it("skips points with no tenant", () => {
    const { rows, skipped } = parseSpanMetrics(payload([point("/x", "200", 1)], null));
    expect(rows).toHaveLength(0);
    expect(skipped).toEqual({ "no-tenant": 1 });
  });

  it("skips cumulative histograms, which would be double counted", () => {
    const { rows, skipped } = parseSpanMetrics(payload([point("/x", "200", 1)], "demo-wallet", 2));
    expect(rows).toHaveLength(0);
    expect(skipped).toEqual({ "not-delta": 1 });
  });

  it("maps a missing or odd status to 0", () => {
    const { rows } = parseSpanMetrics(payload([point("/x", "banana", 1)]));
    expect(rows[0]?.status).toBe(0);
  });

  it("ignores anything that is not the expected shape", () => {
    expect(parseSpanMetrics(null).rows).toEqual([]);
    expect(parseSpanMetrics({ resourceMetrics: "nope" }).rows).toEqual([]);
    expect(parseSpanMetrics({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "other" }] }] }] }).rows).toEqual([]);
  });
});

describe("percentile", () => {
  it("interpolates inside the bucket", () => {
    // 100 calls: 50 under 10 ms, 50 between 10 and 100 ms.
    expect(percentile([10, 100], [50, 50, 0], 0.5)).toBeCloseTo(10);
    expect(percentile([10, 100], [50, 50, 0], 0.95)).toBeCloseTo(91);
  });

  it("reports the lower bound of the open-ended bucket", () => {
    expect(percentile([10, 100], [0, 0, 4], 0.95)).toBe(100);
  });

  it("returns null without data", () => {
    expect(percentile([10, 100], [0, 0, 0], 0.95)).toBeNull();
  });
});
