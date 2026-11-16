# Load test: API analytics path

The RFP asks for about 1,000,000 API requests a day, which is 11.6 per second on average.

## Result (2026-11-16)

| | |
| --- | --- |
| Server | One Hetzner CPX12: 1 shared vCPU, 2 GB RAM, Helsinki. The whole stack on one node. |
| Load | 200 requests per second for 300 seconds |
| Sent | 60,000 spans, 0 failed |
| Stored | 60,000 calls, in 5 normalized routes and 60 rows |
| Lost | 0 |
| Leaked | 0 rows with a raw Stellar address, hash or user id |
| Equivalent daily volume | 17.3 million requests, about 17 times the requirement |
| Ingest latency (gateway, per batch) | p50 4 ms, p95 8 ms, p99 12 ms |
| CPU during the test | gateway under 5%, Collector under 3.1%, PostgreSQL under 2.1% of one vCPU |
| Memory during the test | gateway 34 to 40 MB, Collector 51 to 58 MB, PostgreSQL 45 to 49 MB |
| Restarts | none |

Every span carried a random Stellar account, contract or transaction hash in its path, plus a
`user.id` and a `client.address` attribute that must never be stored. 60,000 distinct paths became
5 routes.

## How to reproduce

```sh
# enroll a throwaway tenant with an OTLP key, then:
docker exec parallax-core-1 node apps/core/src/loadtest.ts http://gateway:8080 <key> 200 300
# compare with what was stored:
select count(distinct route), sum(calls), count(*) from parallax.api_minute where tenant_id = '<tenant>';
```

## What this does and does not show

- It exercises the real path: gateway authentication, the Collector pipeline (filter, tenant
  stamp, path normalization, span metrics, drop) and the writer's upserts into PostgreSQL.
- Spans were synthetic and sent in batches of 20 by a generator on the same host, so network
  latency from a real tenant is not included.
- It covers the API path only. The web event path (gateway to Umami) has not been load tested.
- Storage grows with routes and minutes, not with requests: one minute of one route and status is
  one row whether it saw 10 calls or 10,000. That is why the database stayed idle.
