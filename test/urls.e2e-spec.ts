import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashDeleteToken } from '../src/urls/delete-token';
import { createTestApp, resetDatabase } from './helpers';

describe('URL creation and info (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/api/urls')
      .set('Content-Type', 'application/json')
      .send(body as object);

  describe('POST /api/urls', () => {
    it('creates a short URL, persists it, and returns the delete token once', async () => {
      const res = await post({ url: 'https://example.com/a/very/long/path' }).expect(201);

      expect(res.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        shortCode: expect.stringMatching(/^[0-9A-Za-z]{7}$/),
        shortUrl: `http://localhost:3000/${res.body.shortCode}`,
        originalUrl: 'https://example.com/a/very/long/path',
        expiresAt: null,
        createdAt: expect.any(String),
        deleteToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      expect(res.headers['cache-control']).toBe('no-store');

      const row = await prisma.url.findUnique({ where: { shortCode: res.body.shortCode } });
      expect(row).not.toBeNull();
      expect(row!.originalUrl).toBe('https://example.com/a/very/long/path');
      expect(row!.deleteTokenHash).toBe(hashDeleteToken(res.body.deleteToken));
      expect(row!.deleteTokenHash).not.toBe(res.body.deleteToken);
      expect(row!.isActive).toBe(true);
      expect(row!.clickCount).toBe(0);
    });

    it('stores and returns expiresAt normalised to UTC', async () => {
      const res = await post({
        url: 'https://example.com',
        expiresAt: '2030-01-01T01:00:00+01:00',
      }).expect(201);
      expect(res.body.expiresAt).toBe('2030-01-01T00:00:00.000Z');

      const row = await prisma.url.findUnique({ where: { shortCode: res.body.shortCode } });
      expect(row!.expiresAt!.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    });

    it('returns different codes and tokens for the same URL submitted twice', async () => {
      const a = await post({ url: 'https://example.com' }).expect(201);
      const b = await post({ url: 'https://example.com' }).expect(201);
      expect(a.body.shortCode).not.toBe(b.body.shortCode);
      expect(a.body.deleteToken).not.toBe(b.body.deleteToken);
      expect(await prisma.url.count()).toBe(2);
    });

    it('allocates unique codes under concurrent creation', async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => post({ url: `https://example.com/${i}` })),
      );
      for (const r of results) expect(r.status).toBe(201);
      const codes = new Set(results.map((r) => r.body.shortCode as string));
      expect(codes.size).toBe(25);
    });

    it.each([
      ['missing url', {}, 'url is required'],
      ['non-string url', { url: 42 }, 'url must be a string'],
      ['relative url', { url: '/path' }, 'url must be a valid absolute URL'],
      ['javascript scheme', { url: 'javascript:alert(1)' }, 'url must use http or https'],
      ['data scheme', { url: 'data:text/html,hi' }, 'url must use http or https'],
      [
        'self-referential',
        { url: 'http://localhost:3000/abc1234' },
        'url must not point at this service',
      ],
      [
        'too long',
        { url: 'https://example.com/' + 'a'.repeat(2100) },
        'url must be at most 2048 characters',
      ],
      [
        'past expiry',
        { url: 'https://example.com', expiresAt: '2000-01-01T00:00:00Z' },
        'expiresAt must be in the future',
      ],
      ['non-ISO expiry', { url: 'https://example.com', expiresAt: 'tomorrow' }, 'ISO 8601'],
      [
        'impossible date',
        { url: 'https://example.com', expiresAt: '2030-02-30T00:00:00Z' },
        'not a real calendar date',
      ],
      [
        'beyond horizon',
        { url: 'https://example.com', expiresAt: '2999-01-01T00:00:00Z' },
        'within 3650 days',
      ],
    ])('rejects %s with 400 in the standard error shape', async (_name, body, message) => {
      const res = await post(body).expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(Array.isArray(res.body.message)).toBe(true);
      expect((res.body.message as string[]).join(' | ')).toContain(message);
      expect(typeof res.body.requestId).toBe('string');
      expect(await prisma.url.count()).toBe(0);
    });

    it('rejects a JSON array body', async () => {
      const res = await post([{ url: 'https://example.com' }]).expect(400);
      expect(res.body.message).toEqual(['request body must be a JSON object']);
    });

    it('rejects malformed JSON with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/urls')
        .set('Content-Type', 'application/json')
        .send('{"url": ')
        .expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    });

    it('treats a non-JSON content type as an empty body', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/urls')
        .set('Content-Type', 'text/plain')
        .send('https://example.com')
        .expect(400);
      expect(res.body.message).toEqual(['request body must be a JSON object']);
    });
  });

  describe('GET /api/urls/:shortCode', () => {
    it('returns info for an active URL without leaking internal fields', async () => {
      const created = await post({ url: 'https://example.com/info' }).expect(201);
      const res = await request(app.getHttpServer())
        .get(`/api/urls/${created.body.shortCode}`)
        .expect(200);

      expect(res.body).toEqual({
        shortCode: created.body.shortCode,
        originalUrl: 'https://example.com/info',
        createdAt: created.body.createdAt,
        expiresAt: null,
        clickCount: 0,
        status: 'active',
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('reports expired URLs with 200 and status expired', async () => {
      const created = await post({ url: 'https://example.com' }).expect(201);
      await prisma.url.update({
        where: { shortCode: created.body.shortCode },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await request(app.getHttpServer())
        .get(`/api/urls/${created.body.shortCode}`)
        .expect(200);
      expect(res.body.status).toBe('expired');
    });

    it('reports deleted URLs with 200 and status deleted', async () => {
      const created = await post({ url: 'https://example.com' }).expect(201);
      await prisma.url.update({
        where: { shortCode: created.body.shortCode },
        data: { deletedAt: new Date() },
      });
      const res = await request(app.getHttpServer())
        .get(`/api/urls/${created.body.shortCode}`)
        .expect(200);
      expect(res.body.status).toBe('deleted');
    });

    it('returns 404 for an unknown code', async () => {
      const res = await request(app.getHttpServer()).get('/api/urls/zzzzzzz').expect(404);
      expect(res.body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        message: 'Short URL not found',
      });
    });

    it.each(['abc', 'not-a-code', 'health', 'a'.repeat(13)])(
      'returns 404 for malformed %p',
      async (code) => {
        await request(app.getHttpServer()).get(`/api/urls/${code}`).expect(404);
      },
    );
  });

  describe('OpenAPI document', () => {
    it('documents both endpoints with their status codes', async () => {
      const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
      const create = res.body.paths['/api/urls'].post;
      const info = res.body.paths['/api/urls/{shortCode}'].get;
      expect(Object.keys(create.responses).sort()).toEqual([
        '201',
        '400',
        '413',
        '429',
        '500',
        '503',
        'default',
      ]);
      expect(Object.keys(info.responses).sort()).toEqual(['200', '404', '429', 'default']);
      expect(res.body.components.schemas.CreatedUrlDto.properties).toHaveProperty('deleteToken');
      expect(res.body.components.schemas.UrlInfoDto.properties.status.enum).toEqual([
        'active',
        'expired',
        'deleted',
      ]);
    });
  });
});
