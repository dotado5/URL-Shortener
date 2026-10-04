import { AddressInfo, Server, Socket, createServer } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { bootIsolated } from './isolated';

/**
 * Section 17: Redis must never take redirects down. Two failure shapes are exercised against a
 * fully booted app:
 *
 *   refused  - nothing listens on the Redis port (crashed container, wrong host)
 *   hanging  - TCP accepts but Redis never answers (overloaded, paused, network partition),
 *              which is the dangerous one: without timeouts every request would wait
 *
 * The app reads REDIS_URL at module load, so each scenario boots through `bootIsolated`.
 */

type Helpers = typeof import('./helpers.js');

function bootWithRedisUrl(
  redisUrl: string,
): Promise<{ app: NestExpressApplication; helpers: Helpers }> {
  return bootIsolated(
    {
      REDIS_URL: redisUrl,
      CACHE_BREAKER_FAILURE_THRESHOLD: '3',
      CACHE_BREAKER_RESET_MS: '60000',
      // This suite is about the cache fallback; the limiter's own fail-closed behaviour is
      // covered in rate-limit.e2e-spec.ts.
      RATE_LIMIT_FAIL_MODE: 'open',
    },
    async (load) => {
      const helpers = load<Helpers>('./helpers');
      const app = await helpers.createTestApp();
      await helpers.resetDatabase(app);
      return { app, helpers };
    },
  );
}

/** A TCP server that accepts connections and never writes a byte back. */
function blackhole(): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port, sockets }),
    ),
  );
}

/** A port that was just free: connecting to it is refused. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const scenarios: [name: string, setup: () => Promise<{ url: string; teardown: () => void }>][] = [
  [
    'refused',
    async () => ({ url: `redis://127.0.0.1:${await closedPort()}`, teardown: () => undefined }),
  ],
  [
    'hanging',
    async () => {
      const bh = await blackhole();
      return {
        url: `redis://127.0.0.1:${bh.port}`,
        teardown: () => {
          for (const s of bh.sockets) s.destroy();
          bh.server.close();
        },
      };
    },
  ],
];

describe.each(scenarios)('Redis %s (e2e)', (_name, setup) => {
  let app: NestExpressApplication;
  let helpers: Helpers;
  let teardown: () => void;

  beforeAll(async () => {
    const s = await setup();
    teardown = s.teardown;
    ({ app, helpers } = await bootWithRedisUrl(s.url));
  });

  afterAll(async () => {
    await app.close();
    teardown();
  });

  const http = () => request(app.getHttpServer());

  it('boots and reports ready but degraded, so the load balancer keeps routing', async () => {
    const res = await http().get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'degraded', checks: { database: 'up', redis: 'degraded' } });
  });

  it('creates, redirects, deletes and 404s from PostgreSQL alone, each well under a second', async () => {
    const t0 = Date.now();
    const created = await http()
      .post('/api/urls')
      .set('Content-Type', 'application/json')
      .send({ url: 'https://example.com/fallback' })
      .expect(201);
    const { shortCode, deleteToken } = created.body as { shortCode: string; deleteToken: string };

    for (let i = 0; i < 5; i++) {
      const r = await http().get(`/${shortCode}`).redirects(0).expect(302);
      expect(r.headers.location).toBe('https://example.com/fallback');
    }
    await http().get('/zzzzzzz').expect(404);
    await http().delete(`/api/urls/${shortCode}`).set('X-Delete-Token', deleteToken).expect(204);
    await http().get(`/${shortCode}`).redirects(0).expect(410);

    // 10 requests. With the 50ms command timeout and the breaker this stays far below 1s each.
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('opens the breaker, after which requests skip Redis entirely', async () => {
    expect(await helpers.metricValue(app, 'cache_breaker_state')).toBe(1);
    const bypassBefore = await helpers.metricValue(app, 'cache_operations_total', {
      op: 'get',
      result: 'bypass',
    });

    const t0 = Date.now();
    for (let i = 0; i < 20; i++) await http().get('/zzzzzzz').expect(404);
    const perRequest = (Date.now() - t0) / 20;

    expect(
      await helpers.metricValue(app, 'cache_operations_total', { op: 'get', result: 'bypass' }),
    ).toBe(bypassBefore + 20);
    // No command timeout paid while open.
    expect(perRequest).toBeLessThan(50);
  });

  it('drops clicks instead of failing redirects, and counts the drops', async () => {
    // A dropped enqueue is only counted once ANALYTICS_ENQUEUE_TIMEOUT_MS has elapsed, because
    // BullMQ waits for a connection. The redirects themselves returned long before that.
    const deadline = Date.now() + 3_000;
    let dropped = 0;
    while (Date.now() < deadline) {
      dropped = await helpers.metricValue(app, 'jobs_created_total', { result: 'error' });
      if (dropped > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(dropped).toBeGreaterThan(0);
    expect(await helpers.metricValue(app, 'jobs_created_total', { result: 'ok' })).toBe(0);
  });
});
