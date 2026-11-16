import { normalizePath } from "@parallax/path-rules";

/**
 * Reads the OTLP/JSON metrics the Collector exports and turns the span-metrics
 * duration histogram into per-minute rows. Nothing else in the payload is kept.
 */

export interface ApiRow {
  tenantId: string;
  service: string;
  method: string;
  route: string;
  status: number;
  /** Start of the minute, ISO 8601. */
  minute: string;
  calls: number;
  durationMsSum: number;
  bucketBoundsMs: number[];
  bucketCounts: number[];
}

export interface ParseResult {
  rows: ApiRow[];
  /** Data points skipped, by reason. */
  skipped: Record<string, number>;
}

interface KeyValue {
  key?: string;
  value?: { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
}

function attributes(list: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(list)) return map;
  for (const item of list as KeyValue[]) {
    if (typeof item?.key !== "string" || !item.value) continue;
    const v = item.value;
    const value = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
    if (value !== undefined) map.set(item.key, String(value));
  }
  return map;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

const DELTA = 1;
const DURATION_METRIC = /(^|\.)duration$/;
const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function parseSpanMetrics(payload: unknown): ParseResult {
  const merged = new Map<string, ApiRow>();
  const skipped: Record<string, number> = {};
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  const root = payload as { resourceMetrics?: unknown };
  for (const resourceMetric of asArray(root?.resourceMetrics)) {
    const rm = resourceMetric as { resource?: { attributes?: unknown }; scopeMetrics?: unknown };
    const resource = attributes(rm.resource?.attributes);
    const tenantId = resource.get("parallax.tenant");
    const service = (resource.get("service.name") ?? "unknown").slice(0, 100);

    for (const scopeMetric of asArray(rm.scopeMetrics)) {
      for (const metric of asArray((scopeMetric as { metrics?: unknown }).metrics)) {
        const m = metric as { name?: string; histogram?: { dataPoints?: unknown; aggregationTemporality?: unknown } };
        if (typeof m.name !== "string" || !DURATION_METRIC.test(m.name) || !m.histogram) continue;

        for (const dataPoint of asArray(m.histogram.dataPoints)) {
          if (!tenantId || !TENANT_ID.test(tenantId)) {
            skip("no-tenant");
            continue;
          }
          const temporality = m.histogram.aggregationTemporality;
          if (temporality !== DELTA && temporality !== "AGGREGATION_TEMPORALITY_DELTA") {
            // Cumulative points would be double counted when added up.
            skip("not-delta");
            continue;
          }
          const dp = dataPoint as {
            attributes?: unknown;
            timeUnixNano?: unknown;
            count?: unknown;
            sum?: unknown;
            bucketCounts?: unknown;
            explicitBounds?: unknown;
          };
          const calls = asNumber(dp.count);
          if (calls <= 0) continue;
          const attrs = attributes(dp.attributes);
          const millis = Math.floor(asNumber(dp.timeUnixNano) / 1e6);
          if (millis <= 0) {
            skip("no-timestamp");
            continue;
          }
          // The Collector already normalized the path. Normalizing again here
          // means a misconfigured Collector still cannot store a raw path.
          const route = normalizePath(attrs.get("parallax.route"));
          const method = (attrs.get("parallax.method") ?? "UNKNOWN").toUpperCase().slice(0, 16);
          const statusValue = Number(attrs.get("parallax.status"));
          const status = Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : 0;
          const minute = new Date(Math.floor(millis / 60000) * 60000).toISOString();
          const bucketCounts = asArray(dp.bucketCounts).map(asNumber);
          const bucketBoundsMs = asArray(dp.explicitBounds).map(asNumber);
          if (bucketCounts.length !== bucketBoundsMs.length + 1) {
            skip("bad-histogram");
            continue;
          }

          const key = JSON.stringify([tenantId, service, method, route, status, minute]);
          const existing = merged.get(key);
          if (existing && existing.bucketCounts.length === bucketCounts.length) {
            existing.calls += calls;
            existing.durationMsSum += asNumber(dp.sum);
            existing.bucketCounts = existing.bucketCounts.map((c, i) => c + (bucketCounts[i] ?? 0));
          } else if (!existing) {
            merged.set(key, {
              tenantId,
              service,
              method,
              route,
              status,
              minute,
              calls,
              durationMsSum: asNumber(dp.sum),
              bucketBoundsMs,
              bucketCounts,
            });
          } else {
            skip("bucket-layout-changed");
          }
        }
      }
    }
  }
  return { rows: [...merged.values()], skipped };
}

/**
 * Estimates a percentile from histogram buckets by linear interpolation inside
 * the bucket that contains it. Returns `null` when there is no data.
 */
export function percentile(boundsMs: number[], counts: number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i] ?? 0;
    if (seen + count >= rank && count > 0) {
      const lower = i === 0 ? 0 : (boundsMs[i - 1] ?? 0);
      const upper = boundsMs[i];
      // The last bucket has no upper bound: report its lower bound.
      if (upper === undefined) return lower;
      return lower + ((rank - seen) / count) * (upper - lower);
    }
    seen += count;
  }
  return boundsMs.at(-1) ?? null;
}
