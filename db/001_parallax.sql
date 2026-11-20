-- Astrolabe schema. Lives next to Umami's tables in the same database.
-- Idempotent: safe to run on every start.

create schema if not exists parallax;

create table if not exists parallax.tenant (
  id           text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name         text not null,
  website_id   uuid not null unique,
  domains      text[] not null default '{}',
  -- SHA-256 of the OTLP key. The key itself is never stored.
  api_key_hash text unique,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Every event the gateway saw, by class. Rejections are counted too, with the
-- error code as the reason, so inflation attempts leave a trace.
create table if not exists parallax.ingest_minute (
  tenant_id text not null references parallax.tenant (id) on delete cascade,
  minute    timestamptz not null,
  class     text not null check (class in ('confident', 'low_confidence', 'automated', 'rejected')),
  reason    text not null,
  events    bigint not null,
  primary key (tenant_id, minute, class, reason)
);

-- API traffic: aggregates only. No trace, span or log is ever stored.
create table if not exists parallax.api_minute (
  tenant_id        text not null references parallax.tenant (id) on delete cascade,
  service          text not null,
  method           text not null,
  route            text not null,
  status           integer not null,
  minute           timestamptz not null,
  calls            bigint not null,
  duration_ms_sum  double precision not null,
  bucket_bounds_ms double precision[] not null,
  bucket_counts    bigint[] not null,
  primary key (tenant_id, service, method, route, status, minute)
);

create index if not exists api_minute_tenant_minute_idx on parallax.api_minute (tenant_id, minute);
create index if not exists ingest_minute_tenant_minute_idx on parallax.ingest_minute (tenant_id, minute);

-- Row-level security: a tenant session can read only its own rows. The
-- database enforces this, not only the application.
do $$
begin
  if not exists (select from pg_roles where rolname = 'parallax_tenant') then
    create role parallax_tenant nologin;
  end if;
end
$$;

grant usage on schema parallax to parallax_tenant;
grant select on parallax.api_minute, parallax.ingest_minute to parallax_tenant;

alter table parallax.api_minute enable row level security;
alter table parallax.ingest_minute enable row level security;

drop policy if exists tenant_isolation on parallax.api_minute;
create policy tenant_isolation on parallax.api_minute for select to parallax_tenant
  using (tenant_id = current_setting('parallax.tenant_id', true));

drop policy if exists tenant_isolation on parallax.ingest_minute;
create policy tenant_isolation on parallax.ingest_minute for select to parallax_tenant
  using (tenant_id = current_setting('parallax.tenant_id', true));
