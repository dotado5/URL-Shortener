import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers';

describe('Foundation (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('health', () => {
    it('GET /health/live returns ok without touching dependencies', async () => {
      const res = await request(app.getHttpServer()).get('/health/live').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('GET /health/ready reports the database up', async () => {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks.database).toBe('up');
    });
  });

  describe('metrics', () => {
    it('GET /metrics returns Prometheus text including http metrics', async () => {
      await request(app.getHttpServer()).get('/health/live');
      const res = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('http_requests_total');
      expect(res.text).toContain('http_request_duration_seconds');
      expect(res.text).toContain('route="/health/live"');
    });
  });

  describe('swagger', () => {
    it('GET /api/docs-json serves an OpenAPI document that hides health and metrics', async () => {
      const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
      expect(res.body.openapi).toMatch(/^3\./);
      expect(res.body.info.title).toBe('URL Shortener API');
      expect(Object.keys(res.body.paths)).not.toContain('/metrics');
      expect(Object.keys(res.body.paths)).not.toContain('/health/live');
    });

    it('GET /api/docs serves the UI', async () => {
      await request(app.getHttpServer()).get('/api/docs').expect(200);
    });
  });

  describe('errors and headers', () => {
    it('unknown routes use the standard error shape with a request id', async () => {
      const res = await request(app.getHttpServer()).get('/api/does-not-exist').expect(404);
      expect(res.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
      expect(typeof res.body.requestId).toBe('string');
      expect(res.headers['x-request-id']).toBe(res.body.requestId);
    });

    it('does not trust an incoming X-Request-Id when no proxy is trusted', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/does-not-exist')
        .set('X-Request-Id', 'spoofed')
        .expect(404);
      expect(res.headers['x-request-id']).not.toBe('spoofed');
    });

    it('rejects oversized JSON bodies with 413 in the standard shape', async () => {
      const big = JSON.stringify({ url: 'x'.repeat(20_000) });
      const res = await request(app.getHttpServer())
        .post('/api/urls')
        .set('Content-Type', 'application/json')
        .send(big)
        .expect(413);
      expect(res.body).toMatchObject({ statusCode: 413, error: 'Payload Too Large' });
      // Body-parser rejects before any Nest middleware runs; the id must already exist.
      expect(typeof res.body.requestId).toBe('string');
      expect(res.headers['x-request-id']).toBe(res.body.requestId);
    });

    it('sets security headers and hides x-powered-by', async () => {
      const res = await request(app.getHttpServer()).get('/health/live');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });
});
