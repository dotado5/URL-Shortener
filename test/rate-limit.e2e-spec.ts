import { AddressInfo, createServer } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { bootIsolated } from './isolated';

type Helpers = typeof import('./helpers.js');

const LIMITS = {
  RATE_LIMIT_CREATE_MAX: '3',
  RATE_LIMIT_CREATE_WINDOW_SECONDS: '2',
  RATE_LIMIT_DELETE_MAX: '2',
  RATE_LIMIT_DELETE_WINDOW_SECONDS: '60',
  RATE_LIMIT_INFO_MAX: '4',
  RATE_LIMIT_INFO_WINDOW_SECONDS: '60',
};

function boot(env: Record<string, string>) {
  return bootIsolated({ ...LIMITS, ...env }, async (load) => {
    const helpers = load<Helpers>('./helpers');
    const app = await helpers.createTestApp();
    await helpers.resetDatabase(app);
    return { app, helpers };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Rate limiting (e2e)', () => {
  let app: NestExpressApplication;
  let helpers: Helpers;
  let redis: Redis;

  beforeAll(async () => {
    ({ app, helpers } = await boot({}));
    redis = helpers.testRedis();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const create = (body: object = { url: 'https://example.com' }) =>
    http().post('/api/urls').set('Content-Type', 'application/json').send(body);

  describe('POST /api/urls (3 per 2s)', () => {
    it('allows up to the limit with RateLimit-* headers counting down, then 429', async () => {
      for (const remaining of ['2', '1', '0']) {
        const res = await create().expect(201);
        expect(res.headers['ratelimit-limit']).toBe('3');
        expect(res.headers['ratelimit-remaining']).toBe(remaining);
        expect(Number(res.headers['ratelimit-reset'])).toBeGreaterThanOrEqual(1);
      }

      const blocked = await create().expect(429);
      expect(blocked.body).toMatchObject({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many requests. Please try again later.',
      });
      expect(typeof blocked.body.requestId).toBe('string');
      expect(blocked.headers['ratelimit-remaining']).toBe('0');
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(2);
    });

    it('blocked requests do not consume quota, so the block ends on time', async () => {
      for (let i = 0; i < 3; i++) await create().expect(201);
      for (let i = 0; i < 5; i++) await create().expect(429);
      await sleep(2_100);
      await create().expect(201);
    });

    it('slides: slots free up as individual requests age out, not all at a boundary', async () => {
      await create().expect(201);
      await sleep(1_100);
      await create().expect(201);
      await create().expect(201);
      await create().expect(429);
      // The first request leaves the window about 2s after it was made; the other two do not.
      await sleep(1_000);
      await create().expect(201);
      await create().expect(429);
    });

    it('counts invalid requests too, so probing with bad bodies is not free', async () => {
      for (let i = 0; i < 3; i++) await create({ url: 'ftp://nope' }).expect(400);
      await create().expect(429);
    });

    it('stores only an HMAC of the IP in the key, never the address', async () => {
      await create().expect(201);
      const keys = await redis.keys('rate-limit:*');
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^rate-limit:create:[0-9a-f]{64}$/);
      expect(keys[0]).not.toMatch(/127\.0\.0\.1|::1/);
    });

    it('expires its keys, so idle clients leave nothing behind', async () => {
      await create().expect(201);
      const [key] = await redis.keys('rate-limit:*');
      const pttl = await redis.pttl(key);
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(2_000);
    });
  });

  describe('policies are independent and endpoint-specific', () => {
    it('DELETE has its own budget of 2', async () => {
      for (let i = 0; i < 3; i++) await create().expect(201);
      await create().expect(429);
      await http().delete('/api/urls/zzzzzzz').set('X-Delete-Token', 'x').expect(404);
      await http().delete('/api/urls/zzzzzzz').set('X-Delete-Token', 'x').expect(404);
      const res = await http().delete('/api/urls/zzzzzzz').set('X-Delete-Token', 'x').expect(429);
      expect(res.headers['ratelimit-limit']).toBe('2');
    });

    it('GET info has its own budget of 4', async () => {
      for (let i = 0; i < 4; i++) await http().get('/api/urls/zzzzzzz').expect(404);
      await http().get('/api/urls/zzzzzzz').expect(429);
    });

    it('redirects are never limited by the application and carry no RateLimit headers', async () => {
      const { body } = await create().expect(201);
      for (let i = 0; i < 30; i++) {
        const res = await http().get(`/${body.shortCode}`).redirects(0).expect(302);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
      }
    });

    it('health, metrics and docs are not limited', async () => {
      for (let i = 0; i < 10; i++) {
        await http().get('/health/live').expect(200);
        await http().get('/metrics').expect(200);
      }
    });
  });

  describe('without TRUST_PROXY', () => {
    it('ignores X-Forwarded-For, so a client cannot mint fresh identities', async () => {
      for (let i = 0; i < 3; i++) {
        await create().set('X-Forwarded-For', `198.51.100.${i}`).expect(201);
      }
      await create().set('X-Forwarded-For', '198.51.100.99').expect(429);
    });
  });

  describe('metrics', () => {
    it('counts allowed and blocked decisions per policy', async () => {
      const allowed0 = await helpers.metricValue(app, 'rate_limit_decisions_total', {
        route: 'create',
        result: 'allowed',
      });
      const blocked0 = await helpers.metricValue(app, 'rate_limit_decisions_total', {
        route: 'create',
        result: 'blocked',
      });
      for (let i = 0; i < 3; i++) await create().expect(201);
      await create().expect(429);
      expect(
        await helpers.metricValue(app, 'rate_limit_decisions_total', {
          route: 'create',
          result: 'allowed',
        }),
      ).toBe(allowed0 + 3);
      expect(
        await helpers.metricValue(app, 'rate_limit_decisions_total', {
          route: 'create',
          result: 'blocked',
        }),
      ).toBe(blocked0 + 1);
    });
  });

  describe('OpenAPI document', () => {
    it('documents 429 and 503 on writes, 429 only on info, nothing on redirects', async () => {
      const doc = (await http().get('/api/docs-json').expect(200)).body as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      };
      const create = Object.keys(doc.paths['/api/urls'].post.responses);
      expect(create).toEqual(expect.arrayContaining(['429', '503']));
      const del = Object.keys(doc.paths['/api/urls/{shortCode}'].delete.responses);
      expect(del).toEqual(expect.arrayContaining(['429', '503']));
      const info = Object.keys(doc.paths['/api/urls/{shortCode}'].get.responses);
      expect(info).toContain('429');
      expect(info).not.toContain('503');
      expect(Object.keys(doc.paths['/{shortCode}'].get.responses)).not.toContain('429');
    });
  });
});

describe('Rate limiting behind a trusted proxy (e2e)', () => {
  let app: NestExpressApplication;
  let helpers: Helpers;
  let redis: Redis;

  beforeAll(async () => {
    ({ app, helpers } = await boot({ TRUST_PROXY: 'loopback' }));
    redis = helpers.testRedis();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
    await app.close();
  });

  const create = (xff: string) =>
    request(app.getHttpServer())
      .post('/api/urls')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', xff)
      .send({ url: 'https://example.com' });

  it('gives each client behind the proxy its own bucket', async () => {
    for (let i = 0; i < 3; i++) await create('198.51.100.1').expect(201);
    await create('198.51.100.1').expect(429);
    await create('198.51.100.2').expect(201);
  });

  it('uses the right-most untrusted address, so a spoofed left-most entry changes nothing', async () => {
    for (let i = 0; i < 3; i++) await create('198.51.100.7').expect(201);
    // What a client would send to dodge the limit; the proxy appends the real address.
    await create('6.6.6.6, 198.51.100.7').expect(429);
    await create(`10.${Math.floor(Math.random() * 255)}.0.1, 198.51.100.7`).expect(429);
  });
});

describe('Rate limiter with Redis unavailable (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address() as AddressInfo;
    await new Promise<void>((r) => s.close(() => r()));
    ({ app } = await boot({
      REDIS_URL: `redis://127.0.0.1:${port}`,
      RATE_LIMIT_FAIL_MODE: 'closed',
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('fails closed on create with 503 and Retry-After, quickly', async () => {
    const t0 = Date.now();
    const res = await http()
      .post('/api/urls')
      .set('Content-Type', 'application/json')
      .send({ url: 'https://example.com' })
      .expect(503);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toMatchObject({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Rate limiter unavailable. Please try again shortly.',
    });
  });

  it('fails closed on delete', async () => {
    await http().delete('/api/urls/zzzzzzz').set('X-Delete-Token', 'x').expect(503);
  });

  it('fails open on the read-only info endpoint', async () => {
    await http().get('/api/urls/zzzzzzz').expect(404);
  });

  it('never affects redirects', async () => {
    await http().get('/zzzzzzz').expect(404);
  });
});
