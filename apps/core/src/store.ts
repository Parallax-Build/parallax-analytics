import { readFileSync } from "node:fs";
import type pg from "pg";
import { OVERFLOW_ROUTE } from "@parallax/path-rules";
import { type ApiRow, percentile } from "./otlp.ts";

const MIGRATION = new URL("../../../db/001_parallax.sql", import.meta.url);

/** Applies the schema. Serialized with an advisory lock so two services can start together. */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(74110001)");
    await client.query(readFileSync(MIGRATION, "utf8"));
  } finally {
    await client.query("select pg_advisory_unlock(74110001)").catch(() => undefined);
    client.release();
  }
}

/** Hard cap on distinct routes per tenant. Beyond it, new routes collapse. */
export const ROUTE_CAP = 200;

/**
 * Writes API aggregates. Adds to existing rows for the same minute, and
 * enforces the per-tenant cap on distinct routes.
 */
export class ApiWriter {
  private readonly routes = new Map<string, Set<string>>();
  private readonly pool: pg.Pool;
  private readonly cap: number;

  constructor(pool: pg.Pool, cap = ROUTE_CAP) {
    this.pool = pool;
    this.cap = cap;
  }

  private async knownRoutes(tenantId: string): Promise<Set<string>> {
    let known = this.routes.get(tenantId);
    if (!known) {
      const result = await this.pool.query<{ route: string }>(
        "select distinct route from parallax.api_minute where tenant_id = $1",
        [tenantId],
      );
      known = new Set(result.rows.map((r) => r.route));
      this.routes.set(tenantId, known);
    }
    return known;
  }

  /** @returns The number of rows written and the number collapsed by the cap. */
  async write(rows: ApiRow[]): Promise<{ written: number; collapsed: number; unknownTenant: number }> {
    let written = 0;
    let collapsed = 0;
    let unknownTenant = 0;
    const tenants = new Set((await this.pool.query<{ id: string }>("select id from parallax.tenant")).rows.map((r) => r.id));

    for (const row of rows) {
      if (!tenants.has(row.tenantId)) {
        unknownTenant++;
        continue;
      }
      const known = await this.knownRoutes(row.tenantId);
      let route = row.route;
      if (!known.has(route)) {
        if (known.size >= this.cap) {
          route = OVERFLOW_ROUTE;
          collapsed++;
        }
        known.add(route);
      }
      await this.pool.query(
        `insert into parallax.api_minute
           (tenant_id, service, method, route, status, minute, calls, duration_ms_sum, bucket_bounds_ms, bucket_counts)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (tenant_id, service, method, route, status, minute) do update set
           calls = parallax.api_minute.calls + excluded.calls,
           duration_ms_sum = parallax.api_minute.duration_ms_sum + excluded.duration_ms_sum,
           bucket_counts = (
             select array_agg(a + b order by ord)
             from unnest(parallax.api_minute.bucket_counts, excluded.bucket_counts) with ordinality as t(a, b, ord)
           )`,
        [row.tenantId, row.service, row.method, route, row.status, row.minute, row.calls, row.durationMsSum, row.bucketBoundsMs, row.bucketCounts],
      );
      written++;
    }
    return { written, collapsed, unknownTenant };
  }
}

// --- read side ----------------------------------------------------------------

export interface RouteSummary {
  method: string;
  route: string;
  calls: number;
  errors: number;
  p95Ms: number | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  domains: string[];
  web: { pageviews: number; visitors: number; visits: number; bounceRate: number | null };
  traffic: { confident: number; lowConfidence: number; automated: number; rejected: number; topRejection: string | null };
  api: { calls: number; errors: number; p95Ms: number | null; routes: RouteSummary[] } | null;
}

type Queryable = Pick<pg.Pool, "query">;

async function apiSummary(db: Queryable, since: Date): Promise<Map<string, NonNullable<ProjectSummary["api"]>>> {
  const totals = await db.query<{ tenant_id: string; method: string; route: string; calls: string; errors: string }>(
    `select tenant_id, method, route, sum(calls) as calls, sum(calls) filter (where status >= 500) as errors
     from parallax.api_minute where minute >= $1 group by 1, 2, 3`,
    [since],
  );
  const buckets = await db.query<{ tenant_id: string; method: string; route: string; bounds: number[]; ord: string; c: string }>(
    `select tenant_id, method, route, bucket_bounds_ms as bounds, ord, sum(c) as c
     from parallax.api_minute, unnest(bucket_counts) with ordinality as u(c, ord)
     where minute >= $1 group by 1, 2, 3, 4, 5`,
    [since],
  );

  const histograms = new Map<string, { bounds: number[]; counts: number[] }>();
  for (const row of buckets.rows) {
    const key = `${row.tenant_id}|${row.method}|${row.route}`;
    const histogram = histograms.get(key) ?? { bounds: row.bounds, counts: new Array<number>(row.bounds.length + 1).fill(0) };
    const index = Number(row.ord) - 1;
    histogram.counts[index] = (histogram.counts[index] ?? 0) + Number(row.c);
    histograms.set(key, histogram);
  }

  const result = new Map<string, NonNullable<ProjectSummary["api"]>>();
  const overall = new Map<string, { bounds: number[]; counts: number[] }>();
  for (const row of totals.rows) {
    const summary = result.get(row.tenant_id) ?? { calls: 0, errors: 0, p95Ms: null, routes: [] };
    const histogram = histograms.get(`${row.tenant_id}|${row.method}|${row.route}`);
    const calls = Number(row.calls);
    const errors = Number(row.errors ?? 0);
    summary.calls += calls;
    summary.errors += errors;
    summary.routes.push({
      method: row.method,
      route: row.route,
      calls,
      errors,
      p95Ms: histogram ? percentile(histogram.bounds, histogram.counts, 0.95) : null,
    });
    if (histogram) {
      const all = overall.get(row.tenant_id) ?? { bounds: histogram.bounds, counts: new Array<number>(histogram.counts.length).fill(0) };
      if (all.counts.length === histogram.counts.length) {
        all.counts = all.counts.map((c, i) => c + (histogram.counts[i] ?? 0));
      }
      overall.set(row.tenant_id, all);
    }
    result.set(row.tenant_id, summary);
  }
  for (const [tenantId, summary] of result) {
    const all = overall.get(tenantId);
    summary.p95Ms = all ? percentile(all.bounds, all.counts, 0.95) : null;
    summary.routes.sort((a, b) => b.calls - a.calls);
  }
  return result;
}

/** Cross-project view for operators: every enrolled project, side by side. */
export async function projectSummaries(pool: pg.Pool, since: Date): Promise<ProjectSummary[]> {
  const tenants = await pool.query<{ id: string; name: string; website_id: string; domains: string[] }>(
    "select id, name, website_id, domains from parallax.tenant where enabled order by name",
  );
  // Web numbers come straight from Umami's tables.
  const web = await pool.query<{ website_id: string; pageviews: string; visitors: string; visits: string; bounces: string }>(
    `select website_id,
            sum(views) as pageviews,
            count(distinct session_id) as visitors,
            count(*) as visits,
            count(*) filter (where views = 1) as bounces
     from (
       select website_id, session_id, visit_id, count(*) as views
       from website_event
       where event_type = 1 and created_at >= $1
       group by 1, 2, 3
     ) v
     group by 1`,
    [since],
  );
  const traffic = await pool.query<{ tenant_id: string; class: string; reason: string; events: string }>(
    `select tenant_id, class, reason, sum(events) as events
     from parallax.ingest_minute where minute >= $1 group by 1, 2, 3`,
    [since],
  );
  const api = await apiSummary(pool, since);

  return tenants.rows.map((tenant) => {
    const w = web.rows.find((r) => r.website_id === tenant.website_id);
    const visits = Number(w?.visits ?? 0);
    const counts = { confident: 0, lowConfidence: 0, automated: 0, rejected: 0 };
    let topRejection: { reason: string; events: number } | null = null;
    for (const row of traffic.rows) {
      if (row.tenant_id !== tenant.id) continue;
      const events = Number(row.events);
      if (row.class === "confident") counts.confident += events;
      else if (row.class === "low_confidence") counts.lowConfidence += events;
      else if (row.class === "automated") counts.automated += events;
      else {
        counts.rejected += events;
        if (!topRejection || events > topRejection.events) topRejection = { reason: row.reason, events };
      }
    }
    return {
      id: tenant.id,
      name: tenant.name,
      domains: tenant.domains,
      web: {
        pageviews: Number(w?.pageviews ?? 0),
        visitors: Number(w?.visitors ?? 0),
        visits,
        bounceRate: visits > 0 ? Number(w?.bounces ?? 0) / visits : null,
      },
      traffic: { ...counts, topRejection: topRejection?.reason ?? null },
      api: api.get(tenant.id) ?? null,
    };
  });
}

/**
 * Tenant view of its own API routes. Runs as the `parallax_tenant` role with
 * the tenant id set for the transaction, so PostgreSQL's row-level security
 * decides which rows are visible. The query has no tenant filter on purpose.
 */
export async function tenantApiRoutes(pool: pg.Pool, tenantId: string, since: Date): Promise<RouteSummary[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role parallax_tenant");
    await client.query("select set_config('parallax.tenant_id', $1, true)", [tenantId]);
    const summaries = await apiSummary(client, since);
    await client.query("commit");
    return [...summaries.values()].flatMap((s) => s.routes);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
