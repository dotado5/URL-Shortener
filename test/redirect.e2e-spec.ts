import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, resetDatabase } from './helpers';

describe('Redirects and deletion (e2e)', () => {
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

  const http = () => request(app.getHttpServer());

  async function create(url = 'https://example.com/landing?ref=abc') {
    const res = await http()
      .post('/api/urls')
      .set('Content-Type', 'application/json')
      .send({ url })
      .expect(201);
    return res.body as { shortCode: string; deleteToken: string; originalUrl: string };
  }

  const expire = (shortCode: string) =>
    prisma.url.update({ where: { shortCode }, data: { expiresAt: new Date(Date.now() - 1000) } });

  describe('GET /:shortCode', () => {
    it('redirects with 302, the original Location, and no-store caching', async () => {
      const { shortCode } = await create();
      const res = await http().get(`/${shortCode}`).redirects(0).expect(302);

      expect(res.headers.location).toBe('https://example.com/landing?ref=abc');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.text).toBe('');
    });

    it('preserves percent-encoding and fragments exactly as stored', async () => {
      const { shortCode, originalUrl } = await create(
        'https://example.com/caf%C3%A9/a%20b?q=%26x#section-2',
      );
      const res = await http().get(`/${shortCode}`).redirects(0).expect(302);
      expect(res.headers.location).toBe(originalUrl);
    });

    it('stores non-ASCII destinations percent-encoded so Location is a valid header', async () => {
      const { shortCode } = await create('https://example.com/日本');
      const res = await http().get(`/${shortCode}`).redirects(0).expect(302);
      expect(res.headers.location).toBe('https://example.com/%E6%97%A5%E6%9C%AC');
    });

    it('is case sensitive: a code with different case is a different code', async () => {
      const { shortCode } = await create();
      const flipped = shortCode.replace(/[a-zA-Z]/, (c) =>
        c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
      );
      if (flipped === shortCode) return; // all digits, nothing to flip
      await http().get(`/${flipped}`).redirects(0).expect(404);
    });

    it('answers HEAD with the same status and headers', async () => {
      const { shortCode } = await create();
      const res = await http().head(`/${shortCode}`).redirects(0).expect(302);
      expect(res.headers.location).toBe('https://example.com/landing?ref=abc');
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('does not follow into the destination server-side', async () => {
      // An unroutable destination would hang or fail if the service fetched it.
      const { shortCode } = await create('http://10.255.255.1:9/never');
      await http().get(`/${shortCode}`).redirects(0).timeout(2000).expect(302);
    });
  });

  describe('response matrix (requirement.md section 13)', () => {
    // Every row has four cells: with fewer, Jest mistakes the last callback parameter for `done`.
    type Row = [condition: string, redirect: number, info: number, status: string | null];
    const matrix: Row[] = [
      ['malformed', 404, 404, null],
      ['unknown', 404, 404, null],
      ['active', 302, 200, 'active'],
      ['expired', 410, 200, 'expired'],
      ['deleted', 410, 200, 'deleted'],
    ];

    async function codeFor(condition: string): Promise<string> {
      if (condition === 'malformed') return 'bad-code!';
      if (condition === 'unknown') return 'zzzzzzz';
      const { shortCode, deleteToken } = await create();
      if (condition === 'expired') await expire(shortCode);
      if (condition === 'deleted') {
        await http()
          .delete(`/api/urls/${shortCode}`)
          .set('X-Delete-Token', deleteToken)
          .expect(204);
      }
      return shortCode;
    }

    it.each(matrix)(
      '%s: redirect %i, info %i',
      async (condition, redirectCode, infoCode, status) => {
        const code = await codeFor(condition);

        const redirect = await http().get(`/${code}`).redirects(0);
        expect(redirect.status).toBe(redirectCode);
        expect(redirect.headers['cache-control']).toBe('private, no-store');

        const info = await http().get(`/api/urls/${code}`);
        expect(info.status).toBe(infoCode);
        if (status) expect(info.body.status).toBe(status);
      },
    );

    it('410 bodies use the standard error shape with a reason', async () => {
      const expired = await codeFor('expired');
      const deleted = await codeFor('deleted');

      const a = await http().get(`/${expired}`).expect(410);
      expect(a.body).toMatchObject({
        statusCode: 410,
        error: 'Gone',
        message: 'This short URL has expired',
      });
      expect(typeof a.body.requestId).toBe('string');

      const b = await http().get(`/${deleted}`).expect(410);
      expect(b.body.message).toBe('This short URL has been deleted');
    });

    it('404 bodies use the standard error shape', async () => {
      const res = await http().get('/zzzzzzz').expect(404);
      expect(res.body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        message: 'Short URL not found',
      });
    });
  });

  describe('browser noise and route precedence', () => {
    it.each(['/favicon.ico', '/robots.txt', '/health', '/api', '/docs'])(
      '%s is a 404, never a redirect',
      async (path) => {
        await http().get(path).redirects(0).expect(404);
      },
    );

    it('the catch-all does not shadow /metrics or /health/live', async () => {
      const metrics = await http().get('/metrics').expect(200);
      expect(metrics.text).toContain('http_requests_total');
      await http().get('/health/live').expect(200);
      await http().get('/api/docs').expect(200);
    });

    it('labels redirect metrics by route pattern, never by concrete code', async () => {
      const { shortCode } = await create();
      await http().get(`/${shortCode}`).redirects(0);
      const metrics = await http().get('/metrics');
      expect(metrics.text).toContain('route="/:shortCode"');
      expect(metrics.text).not.toContain(shortCode);
    });
  });

  describe('DELETE /api/urls/:shortCode', () => {
    it('deletes with the token: 204, row soft-deleted, redirect becomes 410', async () => {
      const { shortCode, deleteToken } = await create();
      await http().get(`/${shortCode}`).redirects(0).expect(302);

      const res = await http()
        .delete(`/api/urls/${shortCode}`)
        .set('X-Delete-Token', deleteToken)
        .expect(204);
      expect(res.text).toBe('');

      const row = await prisma.url.findUnique({ where: { shortCode } });
      expect(row).not.toBeNull();
      expect(row!.deletedAt).toBeInstanceOf(Date);

      await http().get(`/${shortCode}`).redirects(0).expect(410);
    });

    it('is idempotent: a repeated delete with the token returns 204 and keeps the first timestamp', async () => {
      const { shortCode, deleteToken } = await create();
      await http().delete(`/api/urls/${shortCode}`).set('X-Delete-Token', deleteToken).expect(204);
      const first = (await prisma.url.findUnique({ where: { shortCode } }))!.deletedAt;

      await http().delete(`/api/urls/${shortCode}`).set('X-Delete-Token', deleteToken).expect(204);
      const second = (await prisma.url.findUnique({ where: { shortCode } }))!.deletedAt;
      expect(second!.getTime()).toBe(first!.getTime());
    });

    it('rejects a missing token with 403 and the redirect keeps working', async () => {
      const { shortCode } = await create();
      const res = await http().delete(`/api/urls/${shortCode}`).expect(403);
      expect(res.body).toMatchObject({ statusCode: 403, error: 'Forbidden' });
      await http().get(`/${shortCode}`).redirects(0).expect(302);
    });

    it("rejects another URL's token with 403", async () => {
      const a = await create('https://example.com/a');
      const b = await create('https://example.com/b');
      await http()
        .delete(`/api/urls/${a.shortCode}`)
        .set('X-Delete-Token', b.deleteToken)
        .expect(403);
      await http().get(`/${a.shortCode}`).redirects(0).expect(302);
    });

    it('returns 404 for an unknown code', async () => {
      await http().delete('/api/urls/zzzzzzz').set('X-Delete-Token', 'anything').expect(404);
    });

    it('returns 404 for a malformed code', async () => {
      await http().delete('/api/urls/bad-code').set('X-Delete-Token', 'anything').expect(404);
    });

    it('keeps the row so analytics survive deletion', async () => {
      const { shortCode, deleteToken } = await create();
      await http().delete(`/api/urls/${shortCode}`).set('X-Delete-Token', deleteToken).expect(204);
      expect(await prisma.url.count()).toBe(1);
    });
  });

  describe('OpenAPI document', () => {
    it('documents the redirect and delete endpoints', async () => {
      const res = await http().get('/api/docs-json').expect(200);
      const follow = res.body.paths['/{shortCode}'].get;
      expect(Object.keys(follow.responses).sort()).toEqual(['302', '404', '410']);
      expect(follow.responses['302'].headers).toHaveProperty('Location');

      const del = res.body.paths['/api/urls/{shortCode}'].delete as {
        responses: Record<string, unknown>;
        parameters: { name: string }[];
      };
      expect(Object.keys(del.responses).sort()).toEqual(['204', '403', '404']);
      expect(del.parameters.map((p) => p.name)).toContain('X-Delete-Token');
    });
  });
});
