# URL Shortener

A production-oriented URL shortening service built to demonstrate backend engineering trade-offs: NestJS, PostgreSQL (Prisma), Redis caching with a database fallback, Redis-backed rate limiting, and BullMQ workers for asynchronous analytics.

The full specification, including the decisions that resolve every ambiguity, lives in [requirement.md](requirement.md). This README covers setup and the parts of the architecture that exist today.

## Status

| Milestone | State |
| --------- | ----- |
| 1. Foundation (config, Prisma, Compose, logging, health, metrics, Swagger, CI) | done |
| 2. URL creation (validation, short codes, delete tokens, create + info endpoints) | done |
| 3. Redirects and deletion (302 redirect, soft delete with token, response matrix) | done |
| 4. Redis cache with circuit breaker | pending |
| 5. Rate limiting | pending |
| 6. BullMQ and analytics | pending |
| 7. Cleanup job | pending |
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

End-to-end tests run against an isolated PostgreSQL (port 5433) and Redis (port 6380) so they never touch development data:

```bash
docker compose --profile test up -d postgres-test redis-test
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/url_shortener_test npx prisma migrate deploy
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
└── generated/prisma/          # generated client (git-ignored)
```

## Design notes that already apply

- **Two processes, one image.** `dist/main` serves HTTP; `dist/worker` will run BullMQ processors. Producers are only wired into the API module, processors only into the worker module.
- **Readiness semantics.** PostgreSQL down means `503` and the instance leaves rotation. Redis down (from Milestone 4) means `200` with `status: degraded`, because redirects fall back to the database. Returning `503` for Redis would let a cache outage drain every task behind the load balancer.
- **Request ids.** An incoming `X-Request-Id` is honoured only when `TRUST_PROXY` is set and the value is a short token; otherwise one is generated. It is assigned by the very first middleware, so even a `413` from the body parser carries it, and it is echoed on the response and included in every error body.
- **Pretty logs are optional.** `pino-pretty` is a dev dependency. The production image omits it, so the logger checks that it resolves before using it and otherwise writes JSON, even when `NODE_ENV` is `development`.
- **Nothing sensitive in logs.** Query strings are redacted, bodies are never logged, and destination URLs will not be logged once they exist.
- **Config fails fast.** Every variable in `.env.example` is validated at boot. In production the process refuses to start without a 32+ character `IP_HASH_SECRET` or with the rate limiter set to fail open.
- **Migrations are a deploy step**, never an app-boot side effect. Locally the `migrate` Compose service runs them; in AWS the same image target runs as a one-off task.
- **Short codes rely on the database for uniqueness.** Codes are 7 random Base62 characters from `crypto.randomInt`, which has no modulo bias. The service inserts and retries on a unique-constraint violation rather than checking first, so two concurrent requests cannot both claim a code. Retries stop after `SHORT_CODE_MAX_ATTEMPTS` with a `500` and a `SHORT_CODE_EXHAUSTED` log. Codes that match a root route such as `health` or `metrics` in any case are re-rolled.
- **Validation is plain functions, not decorators.** Each rule in the specification maps to a named test in `src/urls/url-validation.spec.ts`, and the same function can back any future entry point.
- **One status function.** Whether a URL is active, expired or deleted is decided in `src/urls/url-status.ts`. The redirect endpoint in Milestone 3 will apply it to both cached and database records so they can never disagree.

## Toolchain notes

- NestJS 12 ships as ESM. The project itself compiles to CommonJS (as Nest's own template does) and Jest runs with `--experimental-vm-modules` so it can load Nest.
- TypeScript 6 is pinned because `@nestjs/schematics` requires `>= 6` while `ts-jest` and `typescript-eslint` require `< 7`.
- Prisma 7 requires a driver adapter; this project uses `@prisma/adapter-pg` with an explicit `pg` pool so pool statistics can feed metrics.
