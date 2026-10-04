import type { PinoLogger } from 'nestjs-pino';
import type { CacheLookup, CacheService } from '../cache/cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import { RedirectService } from './redirect.service';

const NOW = new Date('2026-09-29T12:00:00.000Z');

function harness(record: Record<string, unknown> | null, cached: CacheLookup = { kind: 'miss' }) {
  const findUnique = jest.fn().mockResolvedValue(record);
  const prisma = { url: { findUnique } } as unknown as PrismaService;
  const cache = {
    lookup: jest.fn().mockResolvedValue(cached),
    store: jest.fn().mockResolvedValue(undefined),
    storeNegative: jest.fn().mockResolvedValue(undefined),
  };
  const logs: Record<string, unknown>[] = [];
  const logger = {
    setContext: jest.fn(),
    info: jest.fn((obj: Record<string, unknown>) => logs.push(obj)),
  } as unknown as PinoLogger;
  return {
    service: new RedirectService(prisma, cache as unknown as CacheService, logger),
    findUnique,
    cache,
    logs,
  };
}

const active = {
  originalUrl: 'https://example.com/secret?token=abc',
  expiresAt: null,
  deletedAt: null,
};

describe('RedirectService.resolve', () => {
  describe('cache miss → PostgreSQL', () => {
    it('redirects an active URL and populates the cache', async () => {
      const h = harness(active);
      await expect(h.service.resolve('abc1234', NOW)).resolves.toEqual({
        kind: 'redirect',
        location: 'https://example.com/secret?token=abc',
      });
      expect(h.cache.store).toHaveBeenCalledWith('abc1234', active, NOW);
      expect(h.logs[0]).toMatchObject({ event: 'URL_REDIRECTED', source: 'db' });
    });

    it('selects only the fields the decision needs', async () => {
      const h = harness(active);
      await h.service.resolve('abc1234', NOW);
      expect(h.findUnique).toHaveBeenCalledWith({
        where: { shortCode: 'abc1234' },
        select: { originalUrl: true, expiresAt: true, deletedAt: true },
      });
    });

    it('writes a negative entry for an unknown code', async () => {
      const h = harness(null);
      expect((await h.service.resolve('abc1234', NOW)).kind).toBe('not_found');
      expect(h.cache.storeNegative).toHaveBeenCalledWith('abc1234');
      expect(h.cache.store).not.toHaveBeenCalled();
      expect(h.logs.map((l) => l.event)).toEqual(['URL_NOT_FOUND']);
    });

    it('hands expired and deleted records to store, which decides not to cache them', async () => {
      const h = harness({ ...active, expiresAt: new Date(0) });
      expect((await h.service.resolve('abc1234', NOW)).kind).toBe('expired');
      expect(h.cache.store).toHaveBeenCalled();
    });
  });

  describe('cache hit', () => {
    it('redirects without touching PostgreSQL', async () => {
      const h = harness(null, { kind: 'hit', record: active });
      expect(await h.service.resolve('abc1234', NOW)).toEqual({
        kind: 'redirect',
        location: active.originalUrl,
      });
      expect(h.findUnique).not.toHaveBeenCalled();
      expect(h.cache.store).not.toHaveBeenCalled();
      expect(h.logs[0]).toMatchObject({ event: 'URL_REDIRECTED', source: 'cache' });
    });

    it('still validates expiry on a hit, so a stale entry can never redirect', async () => {
      const h = harness(null, {
        kind: 'hit',
        record: { ...active, expiresAt: new Date(NOW.getTime() - 1).toISOString() },
      });
      expect((await h.service.resolve('abc1234', NOW)).kind).toBe('expired');
      expect(h.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('negative cache hit', () => {
    it('returns not_found without touching PostgreSQL', async () => {
      const h = harness(active, { kind: 'negative' });
      expect((await h.service.resolve('abc1234', NOW)).kind).toBe('not_found');
      expect(h.findUnique).not.toHaveBeenCalled();
      expect(h.cache.storeNegative).not.toHaveBeenCalled();
    });
  });

  describe('decisions', () => {
    it('redirects when expiry is still in the future', async () => {
      const h = harness({ ...active, expiresAt: new Date(NOW.getTime() + 1) });
      expect((await h.service.resolve('abc1234', NOW)).kind).toBe('redirect');
    });

    it('reports expired at and after the expiry instant', async () => {
      for (const expiresAt of [NOW, new Date(NOW.getTime() - 1)]) {
        const h = harness({ ...active, expiresAt });
        expect((await h.service.resolve('abc1234', NOW)).kind).toBe('expired');
      }
    });

    it('reports deleted, even when also expired', async () => {
      const past = new Date(NOW.getTime() - 1);
      const h = harness({ ...active, deletedAt: past, expiresAt: past });
      expect((await h.service.resolve('abc1234', NOW)).kind).toBe('deleted');
    });

    it.each(['favicon.ico', 'robots.txt', 'health', 'METRICS', 'abc', 'a'.repeat(13), 'abc-123'])(
      'reports not_found for %p without touching the cache or the database',
      async (code) => {
        const h = harness(active);
        expect((await h.service.resolve(code, NOW)).kind).toBe('not_found');
        expect(h.cache.lookup).not.toHaveBeenCalled();
        expect(h.cache.storeNegative).not.toHaveBeenCalled();
        expect(h.findUnique).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['redirect', active, 'URL_REDIRECTED'],
      ['expired', { ...active, expiresAt: new Date(0) }, 'URL_EXPIRED'],
      ['deleted', { ...active, deletedAt: new Date(0) }, 'URL_DELETED_ACCESSED'],
    ])('logs %s with its event and never the destination', async (_kind, record, event) => {
      const h = harness(record);
      await h.service.resolve('abc1234', NOW);
      expect(h.logs.map((l) => l.event)).toEqual([event]);
      expect(JSON.stringify(h.logs)).not.toContain('example.com');
    });
  });
});
