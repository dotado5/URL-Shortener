import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema';
import { HealthService } from '../health/health.service';
import { MetricsService } from '../metrics/metrics.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CacheRedisClient, CacheService, parseRecord } from './cache.service';

const CONFIG: Partial<Env> = {
  CACHE_TTL_SECONDS: 3600,
  CACHE_NEGATIVE_TTL_SECONDS: 60,
  CACHE_BREAKER_FAILURE_THRESHOLD: 3,
  CACHE_BREAKER_RESET_MS: 10_000,
};

/** In-memory stand-in for ioredis. `fail` makes every command reject, as a dead Redis would. */
class FakeRedis {
  store = new Map<string, { value: string; ttl?: number }>();
  fail = false;
  calls: string[] = [];

  private gate(name: string) {
    this.calls.push(name);
    if (this.fail) return Promise.reject(new Error('Command timed out'));
    return undefined;
  }

  mget(...keys: string[]) {
    return this.gate('mget') ?? Promise.resolve(keys.map((k) => this.store.get(k)?.value ?? null));
  }
  set(key: string, value: string, _ex: string, ttl: number) {
    const g = this.gate('set');
    if (g) return g;
    this.store.set(key, { value, ttl });
    return Promise.resolve('OK');
  }
  del(key: string) {
    const g = this.gate('del');
    if (g) return g;
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }
  ping() {
    return this.gate('ping') ?? Promise.resolve('PONG');
  }
  on() {
    return this;
  }
  quit() {
    return Promise.resolve('OK');
  }
  disconnect() {}
}

function make(redis: FakeRedis | null = new FakeRedis()) {
  const config = { get: (k: keyof Env) => CONFIG[k] } as unknown as ConfigService<Env, true>;
  const logs: Record<string, unknown>[] = [];
  const push = (obj: Record<string, unknown>) => logs.push(obj);
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(push),
    warn: jest.fn(push),
    debug: jest.fn(push),
    error: jest.fn(push),
  } as unknown as PinoLogger;
  const metrics = new MetricsService();
  const health = new HealthService({ ping: () => Promise.resolve() } as unknown as PrismaService);
  const service = new CacheService(
    redis as unknown as CacheRedisClient | null,
    config,
    logger,
    metrics,
    health,
  );
  const count = async (op: string, result: string) => {
    const m = await metrics.cacheOperations.get();
    return m.values.find((v) => v.labels.op === op && v.labels.result === result)?.value ?? 0;
  };
  return { service, redis, logs, metrics, health, count };
}

const NOW = new Date('2026-09-29T12:00:00.000Z');
const active = { originalUrl: 'https://example.com/', expiresAt: null, deletedAt: null };

describe('CacheService', () => {
  afterEach(() => jest.useRealTimers());

  describe('store and lookup', () => {
    it('round-trips a record with the default TTL', async () => {
      const { service, redis } = make();
      await service.store('abc1234', active, NOW);
      expect(redis!.store.get('url:abc1234')).toEqual({
        value: JSON.stringify(active),
        ttl: 3600,
      });
      expect(await service.lookup('abc1234')).toEqual({ kind: 'hit', record: active });
    });

    it('caps the TTL at the remaining lifetime and stores expiresAt as ISO', async () => {
      const { service, redis } = make();
      const expiresAt = new Date(NOW.getTime() + 120_000);
      await service.store('abc1234', { ...active, expiresAt }, NOW);
      const entry = redis!.store.get('url:abc1234')!;
      expect(entry.ttl).toBe(120);
      expect(JSON.parse(entry.value).expiresAt).toBe(expiresAt.toISOString());
    });

    it.each([
      ['deleted', { ...active, deletedAt: new Date(0) }],
      ['expired', { ...active, expiresAt: new Date(0) }],
    ])('does not cache %s records', async (_name, record) => {
      const { service, redis, count } = make();
      await service.store('abc1234', record, NOW);
      expect(redis!.store.size).toBe(0);
      expect(await count('set', 'skipped')).toBe(1);
    });

    it('reports a miss and counts it', async () => {
      const { service, count } = make();
      expect(await service.lookup('abc1234')).toEqual({ kind: 'miss' });
      expect(await count('get', 'miss')).toBe(1);
    });

    it('checks the positive and negative key in one round trip', async () => {
      const { service, redis } = make();
      await service.lookup('abc1234');
      expect(redis!.calls).toEqual(['mget']);
    });

    it('treats an unparseable entry as a miss', async () => {
      const { service, redis, logs } = make();
      redis!.store.set('url:abc1234', { value: '{not json' });
      expect(await service.lookup('abc1234')).toEqual({ kind: 'miss' });
      expect(logs.some((l) => l.event === 'CACHE_ERROR')).toBe(true);
    });
  });

  describe('negative cache', () => {
    it('stores with the negative TTL and reports it on lookup', async () => {
      const { service, redis, count } = make();
      await service.storeNegative('abc1234');
      expect(redis!.store.get('url:notfound:abc1234')).toEqual({ value: '1', ttl: 60 });
      expect(await service.lookup('abc1234')).toEqual({ kind: 'negative' });
      expect(await count('get', 'negative_hit')).toBe(1);
    });

    it('clearNegative removes the entry', async () => {
      const { service } = make();
      await service.storeNegative('abc1234');
      await service.clearNegative('abc1234');
      expect(await service.lookup('abc1234')).toEqual({ kind: 'miss' });
    });

    it('a positive entry wins over a leftover negative one', async () => {
      const { service } = make();
      await service.storeNegative('abc1234');
      await service.store('abc1234', active, NOW);
      expect((await service.lookup('abc1234')).kind).toBe('hit');
    });
  });

  describe('invalidate', () => {
    it('deletes the positive entry and reports success', async () => {
      const { service, redis } = make();
      await service.store('abc1234', active, NOW);
      expect(await service.invalidate('abc1234')).toBe(true);
      expect(redis!.store.has('url:abc1234')).toBe(false);
    });

    it('reports success when there was nothing to delete', async () => {
      expect(await make().service.invalidate('abc1234')).toBe(true);
    });

    it('reports failure when Redis fails', async () => {
      const { service, redis } = make();
      redis!.fail = true;
      expect(await service.invalidate('abc1234')).toBe(false);
    });

    it('still deletes while the breaker is open but Redis has recovered (regression)', async () => {
      const { service, redis } = make();
      await service.store('abc1234', active, NOW);
      redis!.fail = true;
      for (let i = 0; i < 3; i++) await service.lookup('zzzzzzz');
      expect(service.breakerState).toBe('open');

      redis!.fail = false;
      expect(await service.invalidate('abc1234')).toBe(true);
      expect(redis!.store.has('url:abc1234')).toBe(false);
      // A confirmed forced write proves Redis is back, so the breaker closes early.
      expect(service.breakerState).toBe('closed');
    });

    it('does not bypass the breaker for reads or cache fills', async () => {
      const { service, redis } = make();
      redis!.fail = true;
      for (let i = 0; i < 3; i++) await service.lookup('zzzzzzz');
      redis!.fail = false;
      const before = redis!.calls.length;
      await service.lookup('abc1234');
      await service.store('abc1234', active, NOW);
      await service.storeNegative('abc1234');
      expect(redis!.calls.length).toBe(before);
    });
  });

  describe('failure handling', () => {
    it('never throws: failures become misses and no-ops', async () => {
      const { service, redis, count } = make();
      redis!.fail = true;
      await expect(service.lookup('abc1234')).resolves.toEqual({ kind: 'miss' });
      await expect(service.store('abc1234', active, NOW)).resolves.toBeUndefined();
      await expect(service.storeNegative('abc1234')).resolves.toBeUndefined();
      expect(await count('get', 'error')).toBe(1);
    });

    it('opens the breaker after the threshold and stops calling Redis', async () => {
      const { service, redis, logs, count, metrics } = make();
      redis!.fail = true;
      for (let i = 0; i < 3; i++) await service.lookup('abc1234');
      expect(service.breakerState).toBe('open');
      expect(logs.some((l) => l.event === 'CACHE_BREAKER_OPEN')).toBe(true);
      expect((await metrics.cacheBreakerState.get()).values[0].value).toBe(1);

      const before = redis!.calls.length;
      for (let i = 0; i < 10; i++) {
        expect(await service.lookup('abc1234')).toEqual({ kind: 'miss' });
      }
      expect(redis!.calls.length).toBe(before);
      expect(await count('get', 'bypass')).toBe(10);
    });

    it('probes after the reset period and closes once Redis recovers', async () => {
      jest.useFakeTimers({ now: NOW });
      const { service, redis, logs, metrics } = make();
      redis!.fail = true;
      for (let i = 0; i < 3; i++) await service.lookup('abc1234');
      expect(service.breakerState).toBe('open');

      redis!.fail = false;
      jest.setSystemTime(NOW.getTime() + 10_000);
      await service.store('abc1234', active, NOW);
      expect(service.breakerState).toBe('closed');
      expect(logs.some((l) => l.event === 'CACHE_BREAKER_CLOSED')).toBe(true);
      expect((await metrics.cacheBreakerState.get()).values[0].value).toBe(0);
      expect((await service.lookup('abc1234')).kind).toBe('hit');
    });
  });

  describe('readiness', () => {
    it('registers Redis as a non-critical dependency: down means degraded, not down', async () => {
      const { health, redis } = make();
      expect(await health.readiness()).toEqual({
        status: 'ok',
        checks: { database: 'up', redis: 'up' },
      });
      redis!.fail = true;
      expect(await health.readiness()).toEqual({
        status: 'degraded',
        checks: { database: 'up', redis: 'degraded' },
      });
    });

    it('pings Redis directly even while the breaker is open', async () => {
      const { service, redis } = make();
      redis!.fail = true;
      for (let i = 0; i < 3; i++) await service.lookup('abc1234');
      redis!.fail = false;
      expect(await service.ping()).toBe(true);
    });
  });

  describe('disabled (CACHE_ENABLED=false)', () => {
    it('always misses, writes nothing, and does not register a readiness check', async () => {
      const { service, health, logs } = make(null);
      expect(service.enabled).toBe(false);
      expect(await service.lookup('abc1234')).toEqual({ kind: 'miss' });
      await service.store('abc1234', active, NOW);
      expect(await service.invalidate('abc1234')).toBe(true);
      expect((await health.readiness()).checks).toEqual({ database: 'up' });
      expect(logs.some((l) => l.event === 'CACHE_DISABLED')).toBe(true);
    });
  });
});

describe('parseRecord', () => {
  it('accepts a well-formed record', () => {
    expect(parseRecord(JSON.stringify(active))).toEqual(active);
    const withExpiry = { ...active, expiresAt: '2027-01-01T00:00:00.000Z' };
    expect(parseRecord(JSON.stringify(withExpiry))).toEqual(withExpiry);
  });

  it.each([
    ['not JSON', '{'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['missing originalUrl', JSON.stringify({ expiresAt: null, deletedAt: null })],
    ['empty originalUrl', JSON.stringify({ ...active, originalUrl: '' })],
    ['bad expiresAt', JSON.stringify({ ...active, expiresAt: 'soon' })],
    ['numeric expiresAt', JSON.stringify({ ...active, expiresAt: 123 })],
    ['missing expiresAt', JSON.stringify({ originalUrl: 'https://x/', deletedAt: null })],
  ])('rejects %s', (_name, raw) => {
    expect(parseRecord(raw)).toBeNull();
  });
});
