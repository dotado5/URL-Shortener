# URL Shortener with Caching, Rate Limiting & BullMQ

## 1. Project Overview

Build a production-oriented URL shortening service that allows users to create short URLs and redirect visitors to their original URLs.

The project is intended to demonstrate practical backend engineering concepts including:

- REST API design
- URL shortening and unique identifier generation
- PostgreSQL persistence
- Redis caching
- Redis-based rate limiting
- BullMQ asynchronous job processing
- Background workers
- Job retries and failure handling
- URL expiration
- Click analytics
- Observability
- Automated testing
- Load testing
- Containerized local development
- AWS-oriented production architecture

The system should be designed so that the redirect path is optimized for high read volume while non-critical processing is moved to asynchronous workers.

---

## 2. Goals

The system must:

1. Create unique shortened URLs.
2. Redirect users from a short URL to its original URL.
3. Persist URL data in PostgreSQL.
4. Cache frequently accessed URLs using Redis.
5. Rate-limit URL creation requests.
6. Process non-critical work asynchronously using BullMQ.
7. Track basic URL analytics.
8. Support URL expiration.
9. Handle Redis/cache failures gracefully.
10. Provide automated tests.
11. Support local development through Docker Compose.
12. Be structured for eventual deployment to AWS.
13. Provide sufficient logging and metrics to evaluate system performance.

---

## 3. Non-Goals for MVP

The following should not be required for the initial implementation:

- OAuth/social authentication and user accounts
- Multi-tenant organizations
- Custom domains
- Custom aliases (user-chosen short codes)
- Updating a URL's destination after creation
- QR code generation
- Advanced geographic analytics
- Malware/phishing destination screening
- Billing/subscriptions
- Enterprise API management
- Distributed database sharding
- Kubernetes
- Multi-region deployment
- Full frontend application

These may be introduced in later iterations.

---

## 4. Key Decisions

Decisions that resolve ambiguities elsewhere in this document. Each has a short rationale so the trade-off is explicit.

| # | Decision | Rationale |
| - | -------- | --------- |
| D1 | Expiration is enforced at read time. There is no per-URL delayed BullMQ job. | Read-time checks plus a cache TTL capped at expiry already guarantee correctness. Long-delayed jobs live only in Redis and are lost on a non-persistent failover. A periodic sweep marks expired rows inactive. |
| D2 | The redirect endpoint is not rate limited by the application in the MVP. | Redis-backed limiting on redirects would make Redis a single point of failure for redirects, contradicting the fallback design. Abuse protection for redirects belongs at the edge (ALB/WAF/CloudFront). |
| D3 | Rate limiting on write endpoints fails closed with `503` when Redis is unavailable. | Infrastructure failure must not silently remove abuse protection. |
| D4 | Deletion requires a `deleteToken` issued at creation. | Without accounts, an unauthenticated delete lets anyone destroy any URL. |
| D5 | Deletes are soft deletes (`deletedAt` is set). | Preserves analytics and makes `410 Gone` semantically correct. |
| D6 | Deleted and expired URLs return `410 Gone`; unknown codes return `404 Not Found`. | 410 tells clients the resource existed and will not return. |
| D7 | Posting the same original URL twice returns two different short codes. | Deduplication would leak whether a URL has been shortened before and complicates expiry and deletion semantics. |
| D8 | Short codes are 7-character Base62 generated with a CSPRNG. | 62^7 ≈ 3.5 trillion codes. Random codes are not enumerable, unlike encoded database IDs. |
| D9 | Client IP is hashed with HMAC-SHA256 and a server-side secret before it is enqueued or stored. Raw IPs never enter Redis or PostgreSQL. | A plain hash of an IPv4 address is reversible by brute force in seconds. |
| D10 | Analytics is best effort. If the queue is unavailable the redirect still succeeds and the click is lost. | The redirect path is the critical path. |
| D11 | `clickCount` is a Prisma `Int`, not `BigInt`. | `JSON.stringify` throws on `BigInt`. 2^31 clicks per URL is not a realistic MVP constraint. |
| D12 | Tests are part of every milestone's completion criteria, not a separate milestone. | A test milestone at the end is a milestone that gets skipped. |

---

## 5. Technology Stack

### Backend

- Node.js (current LTS)
- TypeScript
- NestJS

### Database

- PostgreSQL
- Prisma ORM (with Prisma Migrate for schema migrations)

### Cache / Queue Infrastructure

- Redis
- BullMQ

Redis serves three purposes:

1. Application caching
2. BullMQ queue backend
3. Rate-limit state

The cache client and the BullMQ connection must be separate Redis connections. BullMQ uses blocking commands and requires `maxRetriesPerRequest: null`, which is unsuitable for the cache client, where commands must fail fast.

### Testing

- Jest
- Supertest
- Testcontainers (or the Docker Compose stack) for integration tests
- k6 for load testing

### Infrastructure

Development:

- Docker
- Docker Compose

Production target:

- AWS
- RDS PostgreSQL
- ElastiCache Redis
- ECS/Fargate or equivalent compute
- Application Load Balancer

---

## 6. High-Level Architecture

```text
                    ┌─────────────────┐
                    │     Client      │
                    └────────┬────────┘
                             │
                             ▼
             ┌───────────────────────────────┐
             │        API Server (NestJS)    │
             │                               │
             │  ┌─────────────────────────┐  │
             │  │ Rate-limit guard        │──┼──► Redis (rate-limit state)
             │  └─────────────────────────┘  │
             │  ┌─────────────────────────┐  │
             │  │ URL / Redirect services │──┼──► Redis (cache)
             │  │                         │──┼──► PostgreSQL
             │  └─────────────────────────┘  │
             │  ┌─────────────────────────┐  │
             │  │ Queue producers         │──┼──► Redis (BullMQ)
             │  └─────────────────────────┘  │
             └───────────────────────────────┘
                                                      │
                                                      ▼
                                            ┌──────────────────┐
                                            │  Worker process  │
                                            │  (BullMQ)        │
                                            └────────┬─────────┘
                                                     │
                                                     ▼
                                                PostgreSQL
```

The redirect path prioritizes speed:

```text
GET /:shortCode
      │
      ▼
    Redis GET  (fast timeout, circuit breaker)
      │
   ┌──┴──────────┐
  HIT       MISS / ERROR
   │              │
   │              ▼
   │         PostgreSQL
   │              │
   │              ▼
   │    Populate Redis (best effort)
   │              │
   └──────┬───────┘
          ▼
 Validate expiry / active
          │
          ▼
   302 + Location
          │
          └──► enqueue analytics (fire-and-forget)
```

---

## 7. Core Functional Requirements

### 7.1 Create Short URL

#### Endpoint

```http
POST /api/urls
```

#### Request

```json
{
  "url": "https://example.com/a/very/long/path",
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

`expiresAt` is optional.

#### Response

```http
HTTP/1.1 201 Created
```

```json
{
  "id": "uuid",
  "shortCode": "a8K2xPq",
  "shortUrl": "https://short.ly/a8K2xPq",
  "originalUrl": "https://example.com/a/very/long/path",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "createdAt": "2026-09-29T00:00:00.000Z",
  "deleteToken": "opaque-random-string"
}
```

`deleteToken` is returned exactly once. Only its hash is stored (see D4 and section 12).

#### Validation Rules

The endpoint must reject, with `400`, any request where:

- `url` is missing, not a string, or not parseable as an absolute URL.
- The scheme is anything other than `http` or `https` (this excludes `javascript:`, `data:`, `file:`, etc.).
- `url` exceeds `MAX_URL_LENGTH` characters (default 2048).
- `url` has the same host as `BASE_URL` (prevents redirect loops through the shortener itself).
- `expiresAt` is present and is not a valid ISO 8601 timestamp.
- `expiresAt` is present and is not in the future.
- `expiresAt` is present and is more than `MAX_EXPIRY_DAYS` in the future (default 3650).

Request bodies larger than `BODY_LIMIT` (default `10kb`) are rejected with `413`.

#### Behaviour

The endpoint must:

- Generate a unique short code (section 8).
- Persist the URL.
- Delete any negative-cache entry for the new short code (section 37).
- Return the shortened URL.
- Be protected by rate limiting (section 18).

The endpoint must not enqueue any BullMQ job and must not wait on Redis other than for the rate-limit check. The client needs the short URL immediately.

---

## 8. URL Short-Code Generation

Short codes are 7 characters from the Base62 alphabet:

```text
abcdefghijklmnopqrstuvwxyz
ABCDEFGHIJKLMNOPQRSTUVWXYZ
0123456789
```

Length is configurable through `SHORT_CODE_LENGTH` (minimum 6).

Codes are generated with a cryptographically secure random source (`crypto.randomBytes` or `crypto.randomInt`). Encoded database IDs are not used because they make every short URL enumerable.

Short codes are case sensitive. `abc` and `ABC` are different codes.

### Reserved Codes

A generated code must be rejected and regenerated if it matches, case-insensitively, any path segment the application serves at the root:

```text
api, health, metrics, docs, favicon.ico, robots.txt
```

The reserved list lives in one place in code and is covered by a unit test.

### Collision Handling

The database enforces uniqueness through a unique constraint on `shortCode`. Generation must rely on that constraint rather than on a check-then-insert race:

```text
Generate code
     │
     ▼
INSERT
     │
 Unique violation?
   /       \
 YES       NO
 │          │
 ▼          ▼
Retry      Success
(max N)
```

Retries are bounded by `SHORT_CODE_MAX_ATTEMPTS` (default 5). Exhausting the retries returns `500` and is logged as `SHORT_CODE_EXHAUSTED`. Under normal conditions this should never happen at 62^7.

---

## 9. Redirect Endpoint

### Endpoint

```http
GET /:shortCode
```

Example:

```http
GET /a8K2xPq
```

Successful response:

```http
HTTP/1.1 302 Found
Location: https://example.com/a/very/long/path
Cache-Control: private, no-store
```

### Redirect Flow

1. If `shortCode` does not match `^[0-9A-Za-z]{6,12}$`, return `404` without touching Redis or PostgreSQL. This also handles `favicon.ico` and similar browser noise.
2. Check the negative cache. If present, return `404`.
3. Check the Redis URL cache.
4. On a hit, use the cached record.
5. On a miss or Redis error, query PostgreSQL.
6. If no row exists, write a negative-cache entry and return `404`.
7. Populate Redis (best effort, errors logged and swallowed).
8. Validate `deletedAt` and `expiresAt`. Either being tripped returns `410`.
9. Return the `302`.
10. Enqueue the analytics job without awaiting it. An enqueue failure is logged as `ANALYTICS_ENQUEUE_FAILED` and never affects the response.

`HEAD` requests follow the same flow but do not enqueue analytics.

### Response Headers

Every redirect response carries `Cache-Control: private, no-store`. Without this, browsers and any CDN placed in front of the service (section 45) would cache the redirect and defeat deletion and expiration.

---

## 10. Redirect Status Code

The MVP uses `302 Found` rather than `301 Moved Permanently`.

A `301` is cached permanently by browsers, which would break:

- URL deletion
- expiration
- analytics (the browser would never hit the server again)

Configurable redirect behaviour is a later enhancement.

---

## 11. URL Information Endpoint

### Endpoint

```http
GET /api/urls/:shortCode
```

Response:

```json
{
  "shortCode": "a8K2xPq",
  "originalUrl": "https://example.com",
  "createdAt": "2026-09-29T10:00:00.000Z",
  "expiresAt": null,
  "clickCount": 153,
  "status": "active"
}
```

`status` is one of `active`, `expired`, `deleted`.

This endpoint is public in the MVP and returns `200` for expired and deleted URLs so their state can be inspected. Unknown codes return `404`. This endpoint is not cached; it reads PostgreSQL directly.

---

## 12. Delete URL

### Endpoint

```http
DELETE /api/urls/:shortCode
X-Delete-Token: <token returned at creation>
```

The endpoint must:

1. Return `404` if the code does not exist.
2. Return `403` if the token is missing or its hash does not match the stored hash. Use a constant-time comparison.
3. Set `deletedAt` (soft delete). The row is retained.
4. Delete the Redis cache key `url:{shortCode}`.
5. Return `204 No Content`.

Deleting an already-deleted URL with a valid token returns `204` (idempotent).

After deletion the redirect endpoint returns `410`.

The delete token is a 32-byte random value, base64url encoded. Only a SHA-256 hash is stored. There is no way to recover a lost token.

---

## 13. URL Expiration

URLs may optionally have an expiration time (see section 7.1 for validation).

When an expired URL is requested:

```http
HTTP/1.1 410 Gone
```

```json
{
  "statusCode": 410,
  "error": "Gone",
  "message": "This short URL has expired"
}
```

Expiration is enforced at read time by comparing `expiresAt` to the current time on every redirect, whether the record came from Redis or PostgreSQL. This is the source of truth (D1).

The cleanup job (section 22) periodically sets `isActive = false` on expired rows. That flag exists for reporting and housekeeping only. The redirect path must not depend on it having run.

### Response Matrix

| Condition | Redirect endpoint | Info endpoint |
| --------- | ----------------- | ------------- |
| Code malformed | `404` | `404` |
| Code unknown | `404` | `404` |
| Active | `302` | `200` (`status: active`) |
| Expired | `410` | `200` (`status: expired`) |
| Deleted | `410` | `200` (`status: deleted`) |

---

## 14. Redis Caching

The system implements the cache-aside pattern.

### Cache Key

```text
url:{shortCode}
```

### Cache Value

The cached value contains everything the redirect path needs to make a decision without a database round trip:

```json
{
  "originalUrl": "https://example.com",
  "expiresAt": null,
  "deletedAt": null
}
```

Deleted URLs are not cached. The cache key is removed on delete. `deletedAt` is included in the shape so the redirect service can apply the same validation function to cached and database-sourced records.

### Cache Flow

```text
Request
   │
   ▼
Redis GET
   │
   ├── HIT ──► validate ──► Redirect
   │
   └── MISS / ERROR
          │
          ▼
      PostgreSQL
          │
          ▼
      Redis SET (best effort)
          │
          ▼
      validate ──► Redirect
```

---

## 15. Cache TTL

For URLs without expiration:

```text
TTL = CACHE_TTL_SECONDS  (default 3600)
```

For URLs with expiration:

```text
TTL = min(CACHE_TTL_SECONDS, seconds until expiresAt)
```

If the computed TTL is zero or negative the record is not cached.

Because expiry is also validated at read time on cache hits, a TTL bug cannot cause an expired URL to redirect. The TTL cap is defence in depth and keeps expired records from occupying memory.

---

## 16. Cache Invalidation

Redis entries must be removed when:

- A URL is deleted.
- Any future operation changes a URL's destination or expiry (no such endpoint exists in the MVP, but the cache service must expose an `invalidate(shortCode)` method so one can be added without touching the cache layer).

Expiration does not require invalidation. The TTL cap and read-time validation handle it.

Invalidation is a `DEL` on `url:{shortCode}`. If the `DEL` fails the delete operation still succeeds, the failure is logged as `CACHE_INVALIDATION_FAILED`, and the stale entry expires naturally within `CACHE_TTL_SECONDS`. This window is an accepted trade-off and must be documented in the README.

---

## 17. Redis Failure Handling

Redis must not become a single point of failure for redirects.

### Redirect Path

If Redis is unavailable or slow, the redirect service falls back to PostgreSQL:

```text
Redis
  │
  X  (error or timeout)
  │
  ▼
PostgreSQL
  │
  ▼
Redirect
```

A slow Redis is more dangerous than a down Redis, because every request would wait for the timeout before falling back. Therefore:

- Every cache command has a timeout of `CACHE_COMMAND_TIMEOUT_MS` (default 50).
- The cache service wraps Redis in a circuit breaker. After `CACHE_BREAKER_FAILURE_THRESHOLD` consecutive failures (default 5) the breaker opens for `CACHE_BREAKER_RESET_MS` (default 10000) and requests go straight to PostgreSQL without attempting Redis.
- Breaker state changes are logged (`CACHE_BREAKER_OPEN`, `CACHE_BREAKER_CLOSED`) and exposed as a metric.

### Rate Limiting

Rate limiting on write endpoints fails closed (D3):

```text
Rate limiter unavailable
        │
        ▼
Return 503
```

The response includes `Retry-After: 5`.

The failure mode is configurable through `RATE_LIMIT_FAIL_MODE=closed|open` so it can be relaxed in development. Production must use `closed`.

### Queue

If BullMQ cannot enqueue an analytics job, the redirect still succeeds (D10).

---

## 18. Rate Limiting

### Algorithm

Sliding-window counter implemented in Redis with an atomic Lua script (or `@nestjs/throttler` with its Redis storage, which does the same). A fixed window is not acceptable because it allows a burst of twice the limit across a window boundary.

The check and the increment must be a single atomic operation.

### Client Identification

The rate-limit key is derived from the client IP:

```text
rate-limit:{route}:{ip}
```

Behind a load balancer the socket address is the balancer, not the client. The application must:

- Read the client IP from `X-Forwarded-For` only when `TRUST_PROXY` is set. Use the right-most address not belonging to a trusted proxy, not the left-most, because the left-most is client-controlled.
- Use the socket address when `TRUST_PROXY` is unset (local development).

This is a security-relevant setting. Misconfiguring it either collapses all users into one bucket (production without `TRUST_PROXY`) or lets clients spoof their IP (development with `TRUST_PROXY` and no real proxy).

Future versions may key by user or API key.

### Policy

| Endpoint | Default | Env vars | Fail mode |
| -------- | ------- | -------- | --------- |
| `POST /api/urls` | 10 / min / IP | `RATE_LIMIT_CREATE_MAX`, `RATE_LIMIT_CREATE_WINDOW_SECONDS` | closed |
| `DELETE /api/urls/:shortCode` | 10 / min / IP | `RATE_LIMIT_DELETE_MAX`, `RATE_LIMIT_DELETE_WINDOW_SECONDS` | closed |
| `GET /api/urls/:shortCode` | 60 / min / IP | `RATE_LIMIT_INFO_MAX`, `RATE_LIMIT_INFO_WINDOW_SECONDS` | open |
| `GET /:shortCode` | not limited | — | — |

The redirect endpoint is not rate limited by the application (D2). Protection for it is an edge concern.

---

## 19. Rate-Limit Response

When the limit is exceeded:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 42
```

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Too many requests. Please try again later."
}
```

`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` are sent on every rate-limited route, not only on `429`. These follow the IETF `RateLimit` header draft. The legacy `X-RateLimit-*` names are not used.

---

## 20. BullMQ

BullMQ is used for asynchronous processing with Redis as the backend.

```text
NestJS API  ──produce──►  Redis  ──consume──►  Worker process  ──►  PostgreSQL
```

The API and the worker are the same codebase with two entry points (`src/main.ts` and `src/worker.ts`) and run as separate processes. The API process never registers a worker. The worker process never listens on HTTP except for its own health endpoint.

Queues:

```text
url-analytics
url-cleanup
```

---

## 21. Analytics Job

Triggered after a successful redirect (a `302` response). Not triggered for `404`, `410`, or `HEAD`.

Payload:

```json
{
  "eventId": "uuid",
  "shortCode": "a8K2xPq",
  "timestamp": "2026-09-29T23:00:00.000Z",
  "userAgent": "...",
  "referer": "...",
  "ipHash": "hmac-sha256-hex"
}
```

- `eventId` is generated by the API and is the idempotency key (section 24).
- `ipHash` is computed in the API process before enqueueing. The raw IP never enters Redis (D9).
- `userAgent` and `referer` are truncated to 512 characters before enqueueing.

The job ID passed to BullMQ is the `eventId`, so BullMQ itself deduplicates an accidental double-enqueue.

The worker, in a single transaction:

1. Inserts a `ClickEvent` row with the `eventId`.
2. Increments `Url.clickCount`.

If the insert fails on the unique `eventId` constraint the job is treated as already processed and completes successfully without incrementing.

---

## 22. Cleanup Job

A repeatable BullMQ job scheduled with a cron expression (`CLEANUP_CRON`, default every 15 minutes). Responsibilities:

- Set `isActive = false` on rows where `expiresAt < now()` and `isActive = true`. Batched by `CLEANUP_BATCH_SIZE` (default 1000) to avoid long-running transactions.
- Delete `ClickEvent` rows older than `ANALYTICS_RETENTION_DAYS` (default 90), batched.
- Log a summary (`CLEANUP_COMPLETED` with counts).

The repeatable job is registered by the worker process on startup with a fixed job ID so multiple worker replicas do not register duplicates.

There is no per-URL delayed expiration job (D1).

---

## 23. BullMQ Retry Policy

Default job options:

```text
attempts: 3
backoff: { type: "exponential", delay: 1000 }
removeOnComplete: { age: 3600, count: 1000 }
removeOnFail: { age: 7 * 24 * 3600 }
```

Failed jobs are retained for seven days so they can be inspected.

Workers must distinguish:

- **Transient failures** (database connection refused, deadlock, timeout): throw a normal error and let BullMQ retry.
- **Permanent failures** (malformed payload, referenced URL row does not exist): throw BullMQ's `UnrecoverableError` so the job goes to failed immediately without wasting retries.

Job processing must complete within `JOB_TIMEOUT_MS` (default 10000). This must be below the container orchestrator's termination grace period (section 34).

---

## 24. Job Idempotency

BullMQ delivers at least once. Every job handler must be safe to run more than once with the same payload.

The analytics job achieves this with a unique constraint on `ClickEvent.eventId` and by performing the insert and the counter increment in one transaction (section 21). The cleanup job is naturally idempotent because its updates are conditional on current state.

The system does not claim exactly-once processing. It claims exactly-once effect for the analytics job, enforced by the database.

---

## 25. Analytics

The MVP supports:

```text
Total clicks per URL
```

The `ClickEvent` table is structured so the following can be derived later without schema changes to existing columns:

- clicks over time
- referrer
- user agent / browser / OS / device (parsed from `userAgent` on read or in a later job)

Not collected in the MVP: country, city, or any geolocation.

Raw IP addresses are never stored. `ipHash` is `HMAC-SHA256(IP_HASH_SECRET, ip)`. Rotating `IP_HASH_SECRET` makes old hashes uncorrelatable with new ones, which is the intended privacy property.

---

## 26. Click Counting

```text
GET /a8K2xPq
      │
      ├── cache/db → 302 to client
      │
      └── enqueue analytics (not awaited)
                │
                ▼
         Analytics Worker
                │
                ▼
     tx { insert ClickEvent; clickCount++ }
```

The API never updates `clickCount` synchronously.

`clickCount` is therefore eventually consistent. The info endpoint may lag the true count by the queue latency. This is documented in the README.

---

## 27. Database Schema

```prisma
model Url {
  id              String    @id @default(uuid())
  shortCode       String    @unique @db.VarChar(12)
  originalUrl     String    @db.VarChar(2048)
  deleteTokenHash String    @db.Char(64)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  expiresAt       DateTime?
  deletedAt       DateTime?
  clickCount      Int       @default(0)
  isActive        Boolean   @default(true)

  clicks ClickEvent[]

  @@index([expiresAt])
  @@index([createdAt])
}

model ClickEvent {
  id        String   @id @default(uuid())
  eventId   String   @unique
  urlId     String
  createdAt DateTime @default(now())
  userAgent String?  @db.VarChar(512)
  referer   String?  @db.VarChar(512)
  ipHash    String?  @db.Char(64)

  url Url @relation(fields: [urlId], references: [id], onDelete: Cascade)

  @@index([urlId, createdAt])
  @@index([createdAt])
}
```

Notes:

- `clickCount` is `Int` (D11).
- `deletedAt` is the soft-delete marker. `isActive` is set by the cleanup sweep for expired rows and is informational.
- `onDelete: Cascade` exists only so that a future hard-delete or GDPR purge behaves sensibly. The application never hard-deletes in the MVP.
- Schema changes go through Prisma Migrate. Migrations are committed. Migrations run as a separate step before the API starts, never on API boot.

---

## 28. API Error Standards

All errors share one shape, produced by a global exception filter:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "url must use http or https",
  "requestId": "uuid"
}
```

Validation errors may return `message` as an array of strings.

Internal errors (`500`) return a generic message. Stack traces and driver error text never reach the client.

Status codes used:

| Code | Used for |
| ---- | -------- |
| `200` | Info endpoint |
| `201` | URL created |
| `204` | URL deleted |
| `302` | Redirect |
| `400` | Validation failure |
| `403` | Invalid or missing delete token |
| `404` | Unknown short code |
| `410` | Expired or deleted short code |
| `413` | Body too large |
| `429` | Rate limit exceeded |
| `500` | Unexpected error |
| `503` | Rate limiter unavailable (fail closed) |

---

## 29. Project Structure

```text
src/
├── main.ts                  # API entry point
├── worker.ts                # Worker entry point
├── app.module.ts
├── worker.module.ts
│
├── config/
│   ├── configuration.ts     # typed, validated env config
│   └── validation.ts
│
├── urls/
│   ├── urls.controller.ts   # POST, GET info, DELETE
│   ├── urls.service.ts
│   ├── urls.module.ts
│   ├── short-code.ts        # generation + reserved list
│   └── dto/
│
├── redirect/
│   ├── redirect.controller.ts
│   ├── redirect.service.ts
│   └── redirect.module.ts
│
├── cache/
│   ├── cache.service.ts     # timeout + circuit breaker live here
│   └── cache.module.ts
│
├── rate-limit/
│   ├── rate-limit.guard.ts
│   ├── rate-limit.service.ts
│   ├── client-ip.ts         # TRUST_PROXY handling
│   └── rate-limit.module.ts
│
├── queues/
│   ├── queues.module.ts     # producers (API side)
│   ├── analytics/
│   │   ├── analytics.producer.ts
│   │   └── analytics.processor.ts
│   └── cleanup/
│       └── cleanup.processor.ts
│
├── health/
│   ├── health.controller.ts # /health/live, /health/ready
│   └── health.module.ts
│
├── metrics/
│   ├── metrics.controller.ts
│   └── metrics.module.ts
│
├── prisma/
│   ├── prisma.service.ts
│   └── prisma.module.ts
│
└── common/
    ├── filters/             # global exception filter
    ├── interceptors/        # request id, logging
    ├── logger/
    └── utils/               # ip hashing, constant-time compare
```

Processors (`*.processor.ts`) are only imported by `worker.module.ts`. Producers are only imported by `app.module.ts`.

---

## 30. Environment Configuration

All variables are validated at startup. A missing required variable fails the boot with a clear message.

```env
NODE_ENV=development
PORT=3000
BASE_URL=http://localhost:3000
TRUST_PROXY=                       # empty locally; e.g. "loopback,uniquelocal" or CIDR list in prod
BODY_LIMIT=10kb
CORS_ORIGINS=                      # comma-separated; empty disables CORS

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/url_shortener

REDIS_URL=redis://localhost:6379

# Short codes
SHORT_CODE_LENGTH=7
SHORT_CODE_MAX_ATTEMPTS=5

# URL validation
MAX_URL_LENGTH=2048
MAX_EXPIRY_DAYS=3650

# Cache
CACHE_ENABLED=true                 # false forces the PostgreSQL path (used by load tests)
CACHE_TTL_SECONDS=3600
CACHE_NEGATIVE_TTL_SECONDS=60
CACHE_COMMAND_TIMEOUT_MS=50
CACHE_BREAKER_FAILURE_THRESHOLD=5
CACHE_BREAKER_RESET_MS=10000

# Rate limiting
RATE_LIMIT_ENABLED=true            # false disables all app-level limits (used by load tests)
RATE_LIMIT_FAIL_MODE=closed
RATE_LIMIT_CREATE_MAX=10
RATE_LIMIT_CREATE_WINDOW_SECONDS=60
RATE_LIMIT_DELETE_MAX=10
RATE_LIMIT_DELETE_WINDOW_SECONDS=60
RATE_LIMIT_INFO_MAX=60
RATE_LIMIT_INFO_WINDOW_SECONDS=60

# Queues
BULLMQ_ANALYTICS_QUEUE=url-analytics
BULLMQ_CLEANUP_QUEUE=url-cleanup
JOB_TIMEOUT_MS=10000
CLEANUP_CRON=*/15 * * * *
CLEANUP_BATCH_SIZE=1000
ANALYTICS_RETENTION_DAYS=90
WORKER_HEALTH_PORT=3001

# Privacy
IP_HASH_SECRET=change-me           # required; boot fails if absent in production

# Shutdown
SHUTDOWN_TIMEOUT_MS=10000

# Observability
LOG_LEVEL=info
METRICS_ENABLED=true
```

Secrets are never committed. Provide `.env.example` with placeholder values.

---

## 31. Docker Compose

Local development starts with:

```bash
docker compose up
```

Services:

```text
postgres   # with a named volume
redis
api        # runs migrations then starts; depends on postgres + redis healthchecks
worker     # depends on postgres + redis healthchecks
```

`api` and `worker` build from the same Dockerfile with different commands. Both must be scalable independently with `docker compose up --scale worker=3`.

A `test` profile (or Testcontainers) provides isolated PostgreSQL and Redis for integration tests so they never share state with the development databases.

---

## 32. Observability

### Structured Logging

JSON logs, one object per line, via a structured logger (pino or equivalent). Every request is assigned a `requestId` (from an incoming `X-Request-Id` header when `TRUST_PROXY` is set, otherwise generated) which appears in every log line for that request and in error responses.

Events:

```text
URL_CREATED
URL_DELETED
URL_REDIRECTED
URL_EXPIRED
URL_NOT_FOUND
CACHE_HIT
CACHE_MISS
CACHE_ERROR
CACHE_BREAKER_OPEN
CACHE_BREAKER_CLOSED
CACHE_INVALIDATION_FAILED
NEGATIVE_CACHE_HIT
RATE_LIMIT_EXCEEDED
RATE_LIMIT_UNAVAILABLE
ANALYTICS_ENQUEUE_FAILED
SHORT_CODE_EXHAUSTED
JOB_STARTED
JOB_COMPLETED
JOB_FAILED
CLEANUP_COMPLETED
```

Example:

```json
{
  "level": "info",
  "event": "CACHE_MISS",
  "requestId": "uuid",
  "shortCode": "a8K2xPq",
  "durationMs": 3,
  "time": "2026-09-29T23:00:00Z"
}
```

Never logged: raw IP addresses, `originalUrl` (destinations frequently carry tokens in query strings), delete tokens, request bodies. `shortCode` is fine.

### Metrics

A Prometheus endpoint at `GET /metrics` exposed from the first milestone, since the load-testing milestone depends on it. It is not listed in Swagger and in production is only reachable from the internal network (ALB does not route to it).

```text
http_requests_total{route,method,status}
http_request_duration_seconds{route,method}   (histogram)

cache_operations_total{op,result}            (result = hit|miss|error)
cache_breaker_state                          (0 closed, 1 open)

rate_limit_decisions_total{route,result}     (result = allowed|blocked|unavailable)

jobs_total{queue,result}                     (result = completed|failed)
job_duration_seconds{queue}                  (histogram)
queue_depth{queue,state}                     (waiting|active|delayed|failed)

db_query_duration_seconds                    (histogram, via Prisma middleware)
```

Derived on the dashboard, not in the app: cache hit ratio, error rate, p50/p95/p99.

---

## 33. Health Checks

Two endpoints, because they answer different questions:

```http
GET /health/live
```

Returns `200` if the process is running and the event loop is responsive. Never checks dependencies. Used by the orchestrator to decide whether to restart the container.

```http
GET /health/ready
```

```json
{
  "status": "ok",
  "checks": {
    "database": "up",
    "redis": "degraded"
  }
}
```

- `database: down` returns `503`. The API cannot serve anything without PostgreSQL.
- `redis: down` returns `200` with `status: "degraded"`. Redirects still work through the fallback. Returning `503` here would make the load balancer drain every task during a Redis outage, which is the outcome the fallback design exists to prevent.

The worker process exposes the same two endpoints on `WORKER_HEALTH_PORT` (default 3001). Its readiness requires both PostgreSQL and Redis because it cannot do anything without the queue.

---

## 34. Graceful Shutdown

On `SIGTERM` and `SIGINT`:

API process:

1. Stop accepting new connections.
2. Fail readiness so the load balancer stops routing.
3. Wait for in-flight requests up to `SHUTDOWN_TIMEOUT_MS` (default 10000).
4. Close BullMQ producers, Redis clients, Prisma.
5. Exit 0.

Worker process:

1. Call `worker.close()`, which stops taking new jobs and waits for active jobs to finish.
2. Close Redis clients and Prisma.
3. Exit 0.

Nest's `enableShutdownHooks()` is used. `JOB_TIMEOUT_MS` (10s) plus close overhead must stay under the ECS default stop timeout of 30 seconds so that no job is killed mid-transaction.

---

## 35. Testing Requirements

Tests are written alongside each milestone (D12). Each milestone's completion criteria include its tests passing in CI.

### Unit Tests

- URL validation (every rule in section 7.1)
- short-code generation, alphabet, length, reserved-word rejection
- collision retry bound
- expiry and deletion validation function (shared by cache and DB paths)
- cache TTL calculation including the expiry cap and the non-cache case
- circuit breaker state transitions
- client IP extraction with and without `TRUST_PROXY`
- rate-limit window arithmetic
- delete-token generation and constant-time verification
- analytics processor idempotency (duplicate `eventId`)

### Integration Tests

Run against real PostgreSQL and Redis (Testcontainers or the compose `test` profile). Redis is flushed between tests so rate-limit state does not leak.

```text
API → PostgreSQL
API → Redis (populate, hit, invalidate, negative cache)
API → Redis down (fallback path, breaker opens)
API → BullMQ → Worker → PostgreSQL
```

### E2E Tests

| Scenario | Expectation |
| -------- | ----------- |
| Create | `201`, row exists, `deleteToken` returned |
| Create with bad scheme / self-referential / past expiry | `400` |
| Redirect | `302`, correct `Location`, `Cache-Control: private, no-store` |
| Redirect twice | first is `CACHE_MISS`, second is `CACHE_HIT` |
| Unknown code | `404`, second request is `NEGATIVE_CACHE_HIT` |
| Create a code that was negatively cached | redirect works immediately |
| Expired URL | `410` |
| Delete without token | `403`, redirect still works |
| Delete with token | `204`, redirect returns `410`, cache key gone |
| Rate limit | requests ≤ limit succeed, request > limit is `429` with `Retry-After` |
| Rate limiter with Redis stopped | `503` on create, `302` on redirect |
| Analytics | redirect → job processed → `clickCount` is 1 → replaying the same job leaves it at 1 |
| Cleanup | expired row gets `isActive = false` after the job runs |

---

## 36. Load Testing

k6 scripts live in `load/` and target the redirect endpoint. The objective is to measure, not to assume, the difference between the Redis and PostgreSQL paths.

Load tests run with:

```env
RATE_LIMIT_ENABLED=false
```

because all k6 traffic originates from one IP. The MISS path is forced with `CACHE_ENABLED=false` rather than by flushing Redis mid-run, so the two runs are directly comparable.

Scenarios:

| Scenario | Shape | Purpose |
| -------- | ----- | ------- |
| A | 100 VUs, 1000 distinct codes, cache on | baseline hit ratio and latency |
| B | 1000 VUs, same codes, cache on | saturation behaviour |
| C | 1000 VUs, one hot code, cache on | single-key hot path |
| D | A and B repeated with `CACHE_ENABLED=false` | PostgreSQL-only comparison |
| E | 100 VUs against `POST /api/urls` with limits disabled | write path baseline |

Measured and recorded in `load/RESULTS.md`:

- requests/sec
- p50, p95, p99 latency
- error rate
- cache hit ratio (from `/metrics`)
- PostgreSQL connections and CPU (from `docker stats`)
- Redis CPU and memory

Results from a laptop are only meaningful relative to each other. The write-up must say so.

---

## 37. Cache Penetration Protection (Negative Caching)

Requests for unknown short codes must not repeatedly hit PostgreSQL.

Key:

```text
url:notfound:{shortCode} → 1
TTL = CACHE_NEGATIVE_TTL_SECONDS (default 60)
```

The create endpoint must `DEL` this key for the newly generated code before returning (section 7.1). Without that, a code requested shortly before it was issued would return `404` for up to the negative TTL.

The malformed-code regex check in section 9 runs before any cache lookup, so junk paths never create negative-cache entries.

Negative caching is implemented in the same milestone as positive caching. It is small and the load tests need it.

---

## 38. Cache Stampede Protection

When a popular URL's cache entry expires, many concurrent requests can miss simultaneously and all hit PostgreSQL.

This is a Phase 2 enhancement, not an MVP requirement. When introduced, prefer in-process request coalescing (one in-flight database lookup per short code per API instance) over a Redis lock, because it adds no Redis dependency and covers the common case. Cross-instance coalescing or refresh-ahead can follow if load tests show a need.

Scenario C in section 36 is designed to make this problem visible and to measure whether the fix is needed.

---

## 39. Security Requirements

The service must:

- Validate URLs per section 7.1, including scheme allow-listing and self-reference rejection.
- Limit request body size (`BODY_LIMIT`).
- Use Prisma's parameterized queries only. No raw SQL with interpolated input.
- Require a delete token for deletion and compare it in constant time.
- Never log or store raw IPs, destination URLs, or delete tokens.
- Hash IPs with a keyed HMAC, not a plain hash.
- Return generic messages for `500` errors.
- Set `TRUST_PROXY` correctly per environment and document the consequences of getting it wrong.
- Send `Cache-Control: private, no-store` on redirects.
- Set standard security headers (helmet) on API responses.
- Restrict CORS to `CORS_ORIGINS` (default none). The redirect endpoint does not need CORS.
- Keep `/metrics` off the public load balancer.

The redirect service must never fetch the destination URL server-side. It issues an HTTP redirect only. This means SSRF is not a concern, but it also means the service cannot detect dead or malicious destinations. Destination screening is a documented non-goal.

Open redirect abuse (phishing through the shortener) is inherent to the product. The delete endpoint plus the `deleteToken` is the MVP's only takedown mechanism. An admin takedown endpoint protected by an API key is a recommended early follow-up.

---

## 40. Performance Requirements

Development targets, measured on the compose stack:

| Path | Target |
| ---- | ------ |
| Create URL | p95 < 300 ms |
| Cached redirect | p95 < 50 ms |
| Database-backed redirect | p95 < 200 ms |
| Redirect with Redis down (breaker open) | p95 within 20% of database-backed |

These are not production SLAs. They exist so a regression is noticeable.

---

## 41. API Documentation

OpenAPI 3 documentation generated from decorators and served at:

```text
GET /api/docs
```

Must document every endpoint, request and response schema, every status code in section 28, the `X-Delete-Token` header, the `RateLimit-*` headers, and the `Cache-Control` behaviour on redirects.

`/metrics` and `/health/*` are excluded from the public document.

---

## 42. Git Requirements

Conventional commits:

```text
feat: initialize NestJS application with config validation
feat: add health endpoints and metrics
feat: add URL creation endpoint
feat: implement short-code generation
feat: add redirect endpoint
feat: add Redis cache-aside with negative caching
feat: add circuit breaker around cache
feat: add Redis-backed rate limiting
feat: add BullMQ analytics queue and worker
feat: add cleanup job
test: add redirect e2e tests
perf: add k6 redirect scenarios
docs: record load test results
```

Never committed: `.env`, credentials, private keys, database dumps, `node_modules`, k6 raw output.

---

## 43. Implementation Order

Each milestone includes its tests and a README update. A milestone is not complete until CI is green.

### Milestone 1 — Foundation

- NestJS + TypeScript project
- typed, validated configuration
- Prisma + PostgreSQL + first migration
- Docker Compose (postgres, redis, api, worker skeleton)
- structured logging with request IDs
- global exception filter
- `/health/live`, `/health/ready`, `/metrics`
- Swagger at `/api/docs`
- CI running lint, unit and integration tests

**Done when:** `docker compose up` starts everything, readiness reports the database up, `/metrics` returns Prometheus text, and CI passes.

### Milestone 2 — URL Creation

- validation rules from section 7.1
- short-code generation with reserved list and bounded retries
- delete-token generation and hashing
- `POST /api/urls`
- `GET /api/urls/:shortCode`

**Done when:** every validation rule has a failing and a passing test, and a created URL can be read back.

### Milestone 3 — Redirects and Deletion

- `GET /:shortCode` against PostgreSQL only
- malformed-code short circuit
- expiry and deletion validation function
- `Cache-Control` header
- `DELETE /api/urls/:shortCode` with token
- response matrix from section 13

**Done when:** the full response matrix is covered by e2e tests.

### Milestone 4 — Redis Cache

- cache service with command timeout and circuit breaker
- cache-aside on the redirect path
- TTL calculation with expiry cap
- negative caching with invalidation on create
- invalidation on delete
- cache metrics

**Done when:** the second redirect is a `CACHE_HIT`, stopping Redis mid-test still yields a `302`, and the breaker opens and closes as configured.

### Milestone 5 — Rate Limiting

- client IP extraction with `TRUST_PROXY`
- atomic sliding-window limiter
- guard on create, delete, info
- `429` with `RateLimit-*` and `Retry-After`
- fail-closed `503` behaviour

**Done when:** limits, headers, and both fail modes are covered by tests, including one with Redis stopped.

### Milestone 6 — BullMQ and Analytics

- separate worker entry point and module
- separate Redis connection for BullMQ
- analytics producer (fire-and-forget) and processor
- transactional, idempotent click counting
- retry and retention configuration, `UnrecoverableError` usage
- queue metrics
- graceful shutdown for both processes

**Done when:** a redirect increments `clickCount` asynchronously, replaying the job does not double count, and a `SIGTERM` during a job lets it finish.

### Milestone 7 — Cleanup Job

- repeatable cleanup job with fixed ID
- expired-row sweep and analytics retention, batched

**Done when:** the sweep runs on schedule, is safe to run twice, and does not register duplicates with multiple workers.

### Milestone 8 — Load Testing and Write-up

- k6 scenarios A to E
- `load/RESULTS.md` with the measurements from section 36
- README architecture section explaining each component, its failure mode, and what the numbers showed

**Done when:** the results document exists and the README answers "why does each piece exist" with data.

### Phase 2 (post-MVP, in rough priority order)

- request coalescing for hot keys (section 38)
- admin takedown endpoint behind an API key
- `PATCH /api/urls/:shortCode` with cache invalidation
- API keys and per-key rate limits
- custom aliases
- analytics breakdowns (time series, referrers)

---

## 44. Definition of Done

The MVP is complete when:

- [ ] A user can create a short URL and receives a delete token.
- [ ] Every validation rule in section 7.1 is enforced and tested.
- [ ] Short codes are unique, random, and never collide with reserved routes.
- [ ] Short URLs redirect with `302` and `Cache-Control: private, no-store`.
- [ ] Unknown, expired and deleted codes return `404`, `410`, `410` respectively.
- [ ] Redis caches lookups; the second request is a cache hit.
- [ ] Negative caching works and is invalidated on create.
- [ ] Cache misses and Redis outages fall back to PostgreSQL through a circuit breaker.
- [ ] Deletion requires the token, invalidates the cache, and is idempotent.
- [ ] Expired URLs never redirect regardless of cache state.
- [ ] Create, delete and info are rate limited with `RateLimit-*` headers.
- [ ] The rate limiter fails closed with `503` when Redis is down; redirects are unaffected.
- [ ] `TRUST_PROXY` is implemented and documented.
- [ ] Analytics jobs are processed asynchronously and are idempotent under replay.
- [ ] Raw IPs never appear in logs, Redis, or PostgreSQL.
- [ ] Failed jobs retry with backoff and are retained for inspection.
- [ ] The cleanup job runs on schedule and is safe with multiple workers.
- [ ] Liveness and readiness endpoints exist with the semantics in section 33.
- [ ] Both processes shut down gracefully.
- [ ] `/metrics` exposes the metrics in section 32.
- [ ] Structured logs carry a request ID.
- [ ] Swagger documents every endpoint, status code and header.
- [ ] Unit, integration and e2e tests exist for each milestone and pass in CI.
- [ ] `docker compose up` starts the full stack.
- [ ] k6 scenarios exist and `load/RESULTS.md` records the measurements.
- [ ] README documents setup, architecture, failure modes, and known trade-offs (invalidation window, eventual click counts).
- [ ] No secrets are committed and `.env.example` is complete.

---

## 45. Future Architecture

```text
                         CloudFront (optional; must honour no-store on redirects)
                             │
                             ▼
                     Application LB  ──► /health/ready
                             │
               ┌─────────────┼─────────────┐
               ▼             ▼             ▼
             ECS           ECS           ECS
             API           API           API
               │             │             │
               └─────────────┼─────────────┘
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
             ElastiCache              RDS
                Redis               PostgreSQL
                  │                     ▲
             BullMQ Queues              │
                  │                     │
          ┌───────┴────────┐            │
          ▼                ▼            │
      ECS Worker       ECS Worker ──────┘
```

Production notes that follow from decisions in this document:

- `TRUST_PROXY` must be set to the ALB's address range.
- ElastiCache should run with Multi-AZ. Persistence is not required because nothing in Redis is a source of truth (D1, D10).
- Prisma's connection pool multiplied by the number of Fargate tasks must stay under RDS `max_connections`. RDS Proxy is the usual answer once task count grows.
- Migrations run as a one-off ECS task before the new API revision is deployed.

Potential later additions:

- PostgreSQL read replicas for the redirect path
- Redis clustering
- SQS or Kafka if event volume outgrows BullMQ
- CDN or edge redirects with short TTLs
- authentication, API keys, custom domains, dashboard
- multi-region deployment

---

## 46. Primary Engineering Principle

The project prioritizes **measurable engineering decisions over unnecessary complexity**.

Every component must have a demonstrable purpose, and every decision in section 4 must remain defensible against the load-test numbers. If a measurement shows a component is not earning its place, the write-up should say so.

```text
Simple URL Shortener
        ↓
PostgreSQL
        ↓
Redis Cache (with fallback)
        ↓
Rate Limiting
        ↓
BullMQ
        ↓
Async Analytics
        ↓
Cleanup Worker
        ↓
Load Testing
        ↓
Performance Optimization
        ↓
AWS Production Architecture
```

The final project should demonstrate not merely that the developer knows how to use NestJS, PostgreSQL, Redis and BullMQ, but that they understand **why each component exists, what problem it solves, what trade-offs it introduces, and how the system behaves when individual components fail.**
