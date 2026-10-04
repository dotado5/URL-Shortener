# URL Shortener

A production-oriented URL shortening service built to demonstrate backend engineering trade-offs: NestJS, PostgreSQL (Prisma), Redis caching with a database fallback, Redis-backed rate limiting, and BullMQ workers for asynchronous analytics.

The full specification, including the decisions that resolve every ambiguity, lives in [requirement.md](requirement.md). This README covers setup and the parts of the architecture that exist today.

## Status

| Milestone | State |
| --------- | ----- |
| 1. Foundation (config, Prisma, Compose, logging, health, metrics, Swagger, CI) | done |
| 2. URL creation (validation, short codes, delete tokens, create + info endpoints) | done |
| 3. Redirects and deletion (302 redirect, soft delete with token, response matrix) | done |
| 4. Redis cache (cache-aside, timeout + circuit breaker, negative cache, invalidation) | done |
| 5. Rate limiting (sliding window, trusted proxy, fail closed) | done |
| 6. BullMQ and analytics (async, idempotent click counting) | done |
| 7. Cleanup job (scheduled expiry sweep and click retention) | done |
| 8. Load testing and write-up | pending |

## Requirements

- Node.js 22 or newer
- Docker with Compose v2

## Quick start

```bash
cp .env.example .env
npm install
npx prisma generate
docker compose up
```

Compose starts PostgreSQL and Redis, runs migrations in a one-off `migrate` container, then starts the API on port 3000 and the worker's health endpoint on port 3001.

If port 3000 is taken, pick another host port. `BASE_URL` follows it, so returned short URLs stay correct:

```bash
API_HOST_PORT=3100 docker compose up
```

In PowerShell:

```powershell
$env:API_HOST_PORT = "3100"; docker compose up
```

To make it stick, add `API_HOST_PORT=3100` to `.env`. Compose reads that file for substitution, and the app ignores the key.

| URL | Purpose |
| --- | ------- |
| http://localhost:3000/api/docs | Swagger UI |
| http://localhost:3000/health/live | Liveness (process is up) |
| http://localhost:3000/health/ready | Readiness (dependencies), `503` only when PostgreSQL is down |
| http://localhost:3000/metrics | Prometheus metrics |

## API

### Create a short URL

```bash
curl -s -X POST http://localhost:3000/api/urls -H 'Content-Type: application/json' -d '{"url":"https://example.com/a/very/long/path","expiresAt":"2027-01-01T00:00:00Z"}'
```

```json
{
  "id": "0b9a6c1e-...",
  "shortCode": "a8K2xPq",
  "shortUrl": "http://localhost:3000/a8K2xPq",
  "originalUrl": "https://example.com/a/very/long/path",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "createdAt": "2026-09-29T00:00:00.000Z",
  "deleteToken": "q0tq2v0mB1m7b6mJ3m1m0Yc0r0v4l5yXoQJr8a7b9cE"
}
```

The `deleteToken` is shown once. Only its SHA-256 hash is stored, so a lost token cannot be recovered. Posting the same URL twice yields two independent short codes.

Validation rejects with `400`, listing every failed rule: a missing or non-string `url`; anything that is not an absolute `http` or `https` URL; whitespace or control characters; more than 2048 characters after normalisation; a destination on this service's own host; and an `expiresAt` that is not an ISO 8601 instant with a time zone, not a real calendar date, not in the future, or more than `MAX_EXPIRY_DAYS` away. Bodies over `BODY_LIMIT` get `413`.

### Inspect a short URL

```bash
curl -s http://localhost:3000/api/urls/a8K2xPq
```

Returns `shortCode`, `originalUrl`, `createdAt`, `expiresAt`, `clickCount` and a `status` of `active`, `expired` or `deleted`. Expired and deleted URLs return `200` so their state stays inspectable. Unknown or malformed codes return `404` without a database query for malformed ones.

### Follow a short URL

```bash
curl -i http://localhost:3000/a8K2xPq
```

```http
HTTP/1.1 302 Found
Location: https://example.com/a/very/long/path
Cache-Control: private, no-store
```

`Cache-Control: private, no-store` is on every response from this route, errors included. Without it, a browser or CDN could keep serving a redirect after the link was deleted or expired. The service never fetches the destination; it only issues the redirect.

### Delete a short URL

```bash
curl -i -X DELETE http://localhost:3000/api/urls/a8K2xPq -H 'X-Delete-Token: <deleteToken from creation>'
```

Returns `204`. The row is kept with `deletedAt` set, so analytics survive and the redirect can answer `410` instead of `404`. Repeating the call with the same token returns `204` again. A missing or wrong token returns `403`.

### Response matrix

| Condition | `GET /:shortCode` | `GET /api/urls/:shortCode` |
| --------- | ----------------- | -------------------------- |
| Malformed or reserved code | `404` | `404` |
| Unknown code | `404` | `404` |
| Active | `302` | `200`, status `active` |
| Expired | `410` | `200`, status `expired` |
| Deleted | `410` | `200`, status `deleted` |

Deletion wins over expiry. `/favicon.ico`, `/robots.txt` and other malformed paths are rejected before any lookup.

### Running on the host

To run the API on the host against the Compose databases instead:

```bash
docker compose up -d postgres redis
npx prisma migrate deploy
npm run start:dev
```

## Tests

Unit tests need no infrastructure:

```bash
npm test
```

End-to-end tests run against an isolated PostgreSQL (port 55433) and Redis (port 56380). The ports are deliberately unusual so a run can never land on development data or on another project's containers. Check that both containers actually started before running tests:

```bash
docker compose --profile test up -d postgres-test redis-test
docker compose --profile test ps postgres-test redis-test
DATABASE_URL=postgresql://postgres:postgres@localhost:55433/url_shortener_test npx prisma migrate deploy
npm run test:e2e
```

CI runs lint, typecheck, build, unit tests, migrations and e2e tests on every push, plus a Docker image build.

### Without Docker

Prisma 7 bundles a local PostgreSQL-compatible server, which is enough for migrations, the API, and the e2e tests until Redis enters the picture in Milestone 4:

```bash
npx prisma dev --name url-shortener-test --detach
export DATABASE_URL='postgres://postgres:postgres@localhost:51214/url_shortener_test?sslmode=disable'
npx prisma migrate deploy
npm run test:e2e
```

Stop it with `npx prisma dev stop url-shortener-test`.

Note for Windows: sending `SIGTERM` from Git Bash or PowerShell terminates a Node process outright, so the graceful-shutdown path in `src/bootstrap.ts` can only be observed under Compose or in CI. Under Compose, `docker compose stop api` shows the full sequence: readiness flips, Prisma disconnects, the process exits 0.

## Project layout

```text
src/
├── main.ts / worker.ts        # two entry points, one codebase
├── bootstrap.ts               # shared app construction: helmet, body limit, CORS, shutdown
├── config/                    # zod-validated environment (boot fails on bad config)
├── prisma/                    # Prisma 7 client via the pg driver adapter
├── common/logger/             # pino JSON logs with a request id on every line
├── common/filters/            # single error shape for every failure
├── health/                    # /health/live and /health/ready
├── metrics/                   # Prometheus registry + HTTP interceptor
├── urls/                      # create, info and delete; pure validation, short-code and token modules
├── redirect/                  # GET /:shortCode catch-all, registered last so it shadows nothing
├── cache/                     # Redis cache-aside, circuit breaker, TTL rules
├── rate-limit/                # sliding-window Lua script, global guard, policies
├── queues/                    # BullMQ producer (API); analytics and cleanup processors (worker)
├── common/utils/ip.ts         # client IP resolution and HMAC hashing
└── generated/prisma/          # generated client (git-ignored)
```

## Caching and failure behaviour

The redirect path reads Redis first and PostgreSQL on a miss:

```text
GET /:shortCode
  malformed or reserved?  → 404, no I/O
  MGET url:{code} url:notfound:{code}      (one round trip)
    negative entry → 404
    hit            → validate expiry/deletion → 302 or 410
    miss / Redis unavailable → PostgreSQL
      no row → SET url:notfound:{code} EX 60 → 404
      row    → SET url:{code} EX min(3600, seconds to expiry) → validate → 302 or 410
```

Expired and deleted URLs are never cached. Every hit is re-validated, so even a wrong TTL cannot make an expired link redirect.

| Situation | What happens |
| --------- | ------------ |
| Redis slow or partitioned | Each command gives up after `CACHE_COMMAND_TIMEOUT_MS` (50 ms) and the request is served from PostgreSQL. |
| Repeated Redis failures | After `CACHE_BREAKER_FAILURE_THRESHOLD` (5) consecutive failures the circuit breaker opens. Requests skip Redis entirely for `CACHE_BREAKER_RESET_MS` (10 s), then one probe decides whether to close it. |
| Redis down at boot | The API starts anyway and reconnects in the background. |
| Readiness while Redis is down | `200` with `"status": "degraded"`. The instance stays in rotation. |
| URL deleted | Row updated first, then `DEL url:{code}`. The delete always tries Redis, even with the breaker open. |
| Invalidation fails | The delete still returns `204` and logs `CACHE_INVALIDATION_FAILED`. The stale entry can serve for up to `CACHE_TTL_SECONDS`. Repeating the delete with the same token retries the invalidation. |
| URL created | `DEL url:notfound:{code}`, so a code probed just before it was issued resolves at once. |
| `CACHE_ENABLED=false` | Every lookup goes to PostgreSQL. Used by the load tests to measure the uncached path. |

Measured under Docker Compose on a laptop, `curl` from the host:

| Condition | Redirect latency |
| --------- | ---------------- |
| Cache healthy | p50 16.6 ms |
| Redis paused, before the breaker opens | p50 31.3 ms, max 131.9 ms, every request still `302` |
| Redis paused, breaker open | p50 15.7 ms, every request `302` |
| Redis resumed, breaker closed again | p50 6.1 ms |

`cache_operations_total{op,result}` and `cache_breaker_state` on `/metrics` show hits, misses, errors, bypasses and the breaker state (0 closed, 1 open, 2 half-open). Per-request `CACHE_HIT`, `CACHE_MISS` and `NEGATIVE_CACHE_HIT` events log at `debug` so the hot path stays cheap at `info`. `CACHE_ERROR` and breaker transitions log at `warn`.

## Rate limiting

| Endpoint | Default | When Redis is down |
| -------- | ------- | ------------------ |
| `POST /api/urls` | 10 per 60 s per IP | `503` with `Retry-After: 5` |
| `DELETE /api/urls/:shortCode` | 10 per 60 s per IP | `503` with `Retry-After: 5` |
| `GET /api/urls/:shortCode` | 60 per 60 s per IP | allowed through |
| `GET /:shortCode` | not limited | unaffected |

- **Sliding window, not fixed.** Each allowed request is a timestamped entry in a Redis sorted set; one Lua script trims, counts and adds atomically, using Redis's clock so instances cannot disagree. A fixed window would let a client send twice the limit across a boundary. Blocked requests are not recorded, so hammering does not extend a block.
- **Headers.** Every limited response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a `429` adds `Retry-After`.
- **Invalid requests count.** The guard runs before validation, so probing with bad bodies spends quota.
- **Redirects are exempt** by design (D2): limiting them in Redis would make Redis a single point of failure for the product's main path. Protect them at the edge.
- **Writes fail closed.** If Redis cannot answer within `RATE_LIMIT_COMMAND_TIMEOUT_MS` (100 ms), creates and deletes get `503` rather than going unprotected. Production refuses to boot with `RATE_LIMIT_FAIL_MODE=open`.
- **Client identity.** Without `TRUST_PROXY` the socket address is used and `X-Forwarded-For` is ignored, so clients cannot mint fresh identities. Behind a load balancer set `TRUST_PROXY` to its address range; Express then takes the right-most untrusted address, so a spoofed left-most entry changes nothing.
- **No raw IPs in Redis.** Keys are `rate-limit:{policy}:{HMAC-SHA256(IP_HASH_SECRET, ip)}`.

## Click analytics

```text
GET /:shortCode → 302 sent → enqueue {eventId, shortCode, timestamp, userAgent, referer, ipHash}   (not awaited)
                                  │
                           BullMQ "url-analytics"  (Redis)
                                  │
worker ──► one SQL statement:  INSERT ClickEvent ... ON CONFLICT (eventId) DO NOTHING
                               UPDATE Url SET clickCount = clickCount + 1  only if a row was inserted
```

- **The redirect never waits.** The job is enqueued after the response is sent. If Redis is down the click is dropped and counted in `jobs_created_total{result="error"}`; the redirect is unaffected (D10).
- **Only real clicks count.** `302` responses to `GET` produce a job. `HEAD`, `404` and `410` do not.
- **Exactly-once effect under at-least-once delivery.** The `eventId` unique index makes replays no-ops, across retries and across concurrent workers. BullMQ also deduplicates re-adds because the job id is the event id.
- **Retries.** 3 attempts with exponential backoff from 1 s. A malformed payload or an unknown short code throws `UnrecoverableError` and fails at once. Failed jobs are kept for 7 days.
- **Timeouts and shutdown.** Each job is bounded by `JOB_TIMEOUT_MS` (10 s). On `SIGTERM` the worker stops taking jobs and waits for active ones, well inside the 30 s container grace period.
- **Privacy.** The IP is hashed in the API process before the job exists, so it never reaches Redis. User agent and referer are truncated to 512 characters. None of them are logged.
- **Readiness.** For the worker, Redis is critical: without it the worker cannot do anything, so readiness returns `503`.
- **Metrics.** API: `jobs_created_total{queue,result}`. Worker: `jobs_total{queue,result}` (`completed`, `duplicate`, `retrying`, `failed`), `job_duration_seconds`, `queue_depth{queue,state}`.
- **`clickCount` is eventually consistent.** The info endpoint can lag the true count by the queue latency, typically well under a second.

Verified under Docker Compose:

| Scenario | Result |
| -------- | ------ |
| Worker stopped, 20 redirects | All `302`; 20 jobs waited in Redis; count caught up within about a second of restart |
| 3 worker replicas, 300 concurrent redirects | All `302`; `clickCount`, `ClickEvent` rows and distinct event ids all exactly 300 higher; work split 129 / 98 / 93 |
| Redis stopped | Creates and deletes `503` in about 10 ms; info and redirects keep working; API `degraded`, worker not ready; both recover when Redis returns |

## Scheduled cleanup

A BullMQ job scheduler runs `cleanup` on `CLEANUP_CRON` (every 15 minutes, UTC). Each run:

1. Marks URLs whose `expiresAt` has passed as `isActive = false`. This is bookkeeping only: redirects check `expiresAt` on every request and never depend on the sweep (D1).
2. Deletes `ClickEvent` rows older than `ANALYTICS_RETENTION_DAYS` (90). `Url.clickCount` is a lifetime total and is not reduced.

| Property | How |
| -------- | --- |
| One run per tick, whatever the replica count | The scheduler lives in Redis under a fixed id; every worker upserts the same one, and BullMQ gives each tick's job to exactly one worker. |
| Short locks | Work happens in batches of `CLEANUP_BATCH_SIZE` (1000), one statement each. |
| Overlapping runs are safe | `FOR UPDATE SKIP LOCKED`: two runs split the rows and never wait on each other. |
| Idempotent | Every statement is conditional on current state; a repeat run finds nothing. |
| Bounded | A run stops after 80% of `JOB_TIMEOUT_MS` and leaves the rest for the next tick. |
| Time-zone proof | The cutoff is computed in the app and passed as UTC. |
| Typos fail fast | `CLEANUP_CRON` is validated at boot with the same parser version BullMQ uses. |

To watch it, run the stack with `CLEANUP_CRON="* * * * *"` and look for `CLEANUP_COMPLETED` in the worker logs; `cleanup_rows_total{action}` counts rows on `/metrics`.

Verified under Docker Compose with three worker replicas and a one-minute schedule:

| Scenario | Result |
| -------- | ------ |
| 3 replicas start together | 1 schedule in Redis |
| Backlog of 2,500 expired URLs and 1,200 events older than 90 days | Cleared by one replica in one run: 5 batches, 153 ms; live URLs and recent events untouched |
| Next tick | Ran on a different replica, changed nothing |
| Invalid `CLEANUP_CRON` | Worker refuses to boot, naming the variable |
| Worker started while Redis is down | Serves `/health/live`, reports not ready, registers the schedule once Redis returns |
| `SIGTERM` while Redis is down | Exits 0 in about 5 s |

## Design notes that already apply

- **Two processes, one image.** `dist/main` serves HTTP; `dist/worker` runs the BullMQ processors. Producers are only wired into the API module, processors only into the worker module. Scale them independently, for example `docker compose up --scale worker=3`.
- **Readiness semantics.** PostgreSQL down means `503` and the instance leaves rotation. Redis down means `200` with `status: degraded`, because redirects fall back to the database. Returning `503` for Redis would let a cache outage drain every task behind the load balancer. Every dependency check is capped at 2 s, so a probe can report "down" but never hang.
- **Shutdown never hangs.** Workers close with a bound: an idle worker is force-closed at once; one with a job in flight gets `JOB_TIMEOUT_MS` + 1 s to drain. `SHUTDOWN_TIMEOUT_MS` (20 s) must exceed `JOB_TIMEOUT_MS` + 3 s, enforced at boot, and stays under the 30 s container grace period.
- **Tests are hermetic.** With `NODE_ENV=test` only `.env.test` is read, never a developer's `.env`.
- **Request ids.** An incoming `X-Request-Id` is honoured only when `TRUST_PROXY` is set and the value is a short token; otherwise one is generated. It is assigned by the very first middleware, so even a `413` from the body parser carries it, and it is echoed on the response and included in every error body.
- **Pretty logs are optional.** `pino-pretty` is a dev dependency. The production image omits it, so the logger checks that it resolves before using it and otherwise writes JSON, even when `NODE_ENV` is `development`.
- **Nothing sensitive in logs.** Query strings are redacted, bodies are never logged, and destination URLs, delete tokens, IPs, user agents and referers never appear in any log line.
- **Config fails fast.** Every variable in `.env.example` is validated at boot. In production the process refuses to start without a 32+ character `IP_HASH_SECRET` or with the rate limiter set to fail open.
- **Migrations are a deploy step**, never an app-boot side effect. Locally the `migrate` Compose service runs them; in AWS the same image target runs as a one-off task.
- **Short codes rely on the database for uniqueness.** Codes are 7 random Base62 characters from `crypto.randomInt`, which has no modulo bias. The service inserts and retries on a unique-constraint violation rather than checking first, so two concurrent requests cannot both claim a code. Retries stop after `SHORT_CODE_MAX_ATTEMPTS` with a `500` and a `SHORT_CODE_EXHAUSTED` log. Codes that match a root route such as `health` or `metrics` in any case are re-rolled.
- **Validation is plain functions, not decorators.** Each rule in the specification maps to a named test in `src/urls/url-validation.spec.ts`, and the same function can back any future entry point.
- **One status function.** Whether a URL is active, expired or deleted is decided in `src/urls/url-status.ts`. The redirect endpoint applies it to both cached and database records so they can never disagree.
- **Four Redis connections, each tuned for its job.** The cache fails fast (50 ms, circuit breaker). The rate limiter fails fast (100 ms, no breaker, since every write needs a real answer). The BullMQ producer fails fast (500 ms, never awaited). The BullMQ worker blocks and retries forever, as BullMQ requires.

## Toolchain notes

- NestJS 12 ships as ESM. The project itself compiles to CommonJS (as Nest's own template does) and Jest runs with `--experimental-vm-modules` so it can load Nest.
- TypeScript 6 is pinned because `@nestjs/schematics` requires `>= 6` while `ts-jest` and `typescript-eslint` require `< 7`.
- Prisma 7 requires a driver adapter; this project uses `@prisma/adapter-pg` with an explicit `pg` pool so pool statistics can feed metrics.
