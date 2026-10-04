import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import * as shortCodes from '../src/urls/short-code';
import { createTestApp, metricValue, resetDatabase, testRedis } from './helpers';

describe('Redis cache (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let redis: Redis;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    redis = testRedis();
  });

  beforeEach(async () => {
    await resetDatabase(app);
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const gets = (result: string) =>
    metricValue(app, 'cache_operations_total', { op: 'get', result });

  async function create(body: Record<string, unknown> = { url: 'https://example.com/cached' }) {
    const res = await http().post('/api/urls').set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(201);
    return res.body as { shortCode: string; deleteToken: string };
  }

  it('first redirect misses and populates Redis; the second is a hit without PostgreSQL', async () => {
    const { shortCode } = await create();
    const [miss0, hit0] = [await gets('miss'), await gets('hit')];

    await http().get(`/${shortCode}`).redirects(0).expect(302);
    expect(await gets('miss')).toBe(miss0 + 1);

    const raw = await redis.get(`url:${shortCode}`);
    expect(JSON.parse(raw!)).toEqual({
      originalUrl: 'https://example.com/cached',
      expiresAt: null,
      deletedAt: null,
    });
    const ttl = await redis.ttl(`url:${shortCode}`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);

    // Prove the second request never reads the database: change the row underneath the cache.
    await prisma.url.update({
      where: { shortCode },
      data: { originalUrl: 'https://example.com/changed-in-db' },
    });
    const res = await http().get(`/${shortCode}`).redirects(0).expect(302);
    expect(res.headers.location).toBe('https://example.com/cached');
    expect(await gets('hit')).toBe(hit0 + 1);
  });

  it('caps the TTL at the URL expiry', async () => {
    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    const { shortCode } = await create({ url: 'https://example.com', expiresAt });
    await http().get(`/${shortCode}`).redirects(0).expect(302);
    const ttl = await redis.ttl(`url:${shortCode}`);
    expect(ttl).toBeGreaterThan(80);
    expect(ttl).toBeLessThanOrEqual(90);
  });

  it('a cached entry for an expired URL still returns 410, never a redirect', async () => {
    const { shortCode } = await create();
    // A deliberately wrong entry: long TTL, expiry in the past.
    await redis.set(
      `url:${shortCode}`,
      JSON.stringify({
        originalUrl: 'https://example.com/cached',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        deletedAt: null,
      }),
      'EX',
      3600,
    );
    await http().get(`/${shortCode}`).redirects(0).expect(410);
  });

  it('does not cache expired or deleted URLs', async () => {
    const a = await create();
    await prisma.url.update({
      where: { shortCode: a.shortCode },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await http().get(`/${a.shortCode}`).redirects(0).expect(410);
    expect(await redis.exists(`url:${a.shortCode}`)).toBe(0);

    const b = await create();
    await http()
      .delete(`/api/urls/${b.shortCode}`)
      .set('X-Delete-Token', b.deleteToken)
      .expect(204);
    await http().get(`/${b.shortCode}`).redirects(0).expect(410);
    expect(await redis.exists(`url:${b.shortCode}`)).toBe(0);
  });

  describe('deletion invalidates the cache', () => {
    it('a cached URL returns 410 immediately after delete', async () => {
      const { shortCode, deleteToken } = await create();
      await http().get(`/${shortCode}`).redirects(0).expect(302);
      expect(await redis.exists(`url:${shortCode}`)).toBe(1);

      await http().delete(`/api/urls/${shortCode}`).set('X-Delete-Token', deleteToken).expect(204);
      expect(await redis.exists(`url:${shortCode}`)).toBe(0);
      await http().get(`/${shortCode}`).redirects(0).expect(410);
    });

    it('a rejected delete leaves the cache alone', async () => {
      const { shortCode } = await create();
      await http().get(`/${shortCode}`).redirects(0).expect(302);
      await http().delete(`/api/urls/${shortCode}`).set('X-Delete-Token', 'wrong').expect(403);
      expect(await redis.exists(`url:${shortCode}`)).toBe(1);
    });
  });

  describe('negative caching', () => {
    it('an unknown code is cached as not-found for the negative TTL', async () => {
      await http().get('/zzzzzzz').expect(404);
      expect(await redis.get('url:notfound:zzzzzzz')).toBe('1');
      const ttl = await redis.ttl('url:notfound:zzzzzzz');
      expect(ttl).toBeGreaterThan(50);
      expect(ttl).toBeLessThanOrEqual(60);

      const before = await gets('negative_hit');
      await http().get('/zzzzzzz').expect(404);
      expect(await gets('negative_hit')).toBe(before + 1);
    });

    it('malformed paths never create negative entries', async () => {
      await http().get('/favicon.ico').expect(404);
      await http().get('/bad-code').expect(404);
      expect(await redis.keys('url:notfound:*')).toEqual([]);
    });

    it('creating a code that was negatively cached makes it resolve immediately', async () => {
      // Pin the next generated code so we can probe it before it exists.
      const spy = jest.spyOn(shortCodes, 'generateShortCode').mockReturnValueOnce('Probe12');
      try {
        await http().get('/Probe12').expect(404);
        expect(await redis.exists('url:notfound:Probe12')).toBe(1);

        const created = await create({ url: 'https://example.com/just-issued' });
        expect(created.shortCode).toBe('Probe12');
        expect(await redis.exists('url:notfound:Probe12')).toBe(0);

        const res = await http().get('/Probe12').redirects(0).expect(302);
        expect(res.headers.location).toBe('https://example.com/just-issued');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('readiness and metrics', () => {
    it('reports Redis up alongside the database', async () => {
      const res = await http().get('/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    });

    it('exposes the breaker as closed', async () => {
      expect(await metricValue(app, 'cache_breaker_state')).toBe(0);
    });
  });
});
