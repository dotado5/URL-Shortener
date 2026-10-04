import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema';
import { HealthService } from '../health/health.service';
import { MetricsService } from '../metrics/metrics.service';
import type { UrlLifecycle } from '../urls/url-status';
import { cacheTtlSeconds } from './cache-ttl';
import { BreakerState, CircuitBreaker } from './circuit-breaker';

/** What the redirect path needs; the same shape comes from PostgreSQL or from Redis. */
export interface CachedUrl extends UrlLifecycle {
  originalUrl: string;
}

export type CacheLookup =
  | { kind: 'hit'; record: CachedUrl }
  | { kind: 'negative' }
  /** Not in cache, or cache unavailable. Either way the caller goes to PostgreSQL. */
  | { kind: 'miss' };

/** Injection token for the cache's Redis client; `null` when CACHE_ENABLED is false. */
export const CACHE_REDIS = Symbol('CACHE_REDIS');

/** The subset of ioredis the cache uses, so tests can supply a fake. */
export type CacheRedisClient = Pick<
  Redis,
  'mget' | 'set' | 'del' | 'ping' | 'quit' | 'disconnect' | 'on'
>;

export const urlKey = (shortCode: string) => `url:${shortCode}`;
export const notFoundKey = (shortCode: string) => `url:notfound:${shortCode}`;

const BREAKER_GAUGE: Record<BreakerState, number> = { closed: 0, open: 1, half_open: 2 };

/**
 * Cache-aside store for redirect records (sections 14-17 and 37).
 *
 * Every public method is best effort and never throws: a Redis failure turns into a miss or a
 * no-op, and the caller falls back to PostgreSQL. Commands time out after
 * CACHE_COMMAND_TIMEOUT_MS, commands issued while disconnected fail immediately instead of
 * queueing, and a circuit breaker stops trying altogether once Redis is known to be unhealthy.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  readonly enabled: boolean;
  private readonly breaker: CircuitBreaker;
  private readonly ttlSeconds: number;
  private readonly negativeTtlSeconds: number;
  private connected = false;

  constructor(
    @Inject(CACHE_REDIS) private readonly redis: CacheRedisClient | null,
    config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
    health: HealthService,
  ) {
    this.logger.setContext(CacheService.name);
    this.enabled = redis !== null;
    this.ttlSeconds = config.get('CACHE_TTL_SECONDS', { infer: true });
    this.negativeTtlSeconds = config.get('CACHE_NEGATIVE_TTL_SECONDS', { infer: true });

    this.breaker = new CircuitBreaker({
      failureThreshold: config.get('CACHE_BREAKER_FAILURE_THRESHOLD', { infer: true }),
      resetMs: config.get('CACHE_BREAKER_RESET_MS', { infer: true }),
      onStateChange: (from, to) => this.onBreakerChange(from, to),
    });
    this.metrics.cacheBreakerState.set(0);

    if (redis === null) {
      this.logger.info(
        { event: 'CACHE_DISABLED' },
        'cache disabled; every lookup reads PostgreSQL',
      );
      return;
    }

    redis.on('ready', () => {
      if (!this.connected) this.logger.info({ event: 'CACHE_CONNECTED' }, 'cache connected');
      this.connected = true;
    });
    redis.on('close', () => {
      if (this.connected) {
        this.logger.warn({ event: 'CACHE_DISCONNECTED' }, 'cache connection lost');
      }
      this.connected = false;
    });
    // Without a listener ioredis would crash the process on connection errors. The breaker and
    // CACHE_ERROR events already report failures, so reconnect noise is kept at debug.
    redis.on('error', (err: Error) => {
      this.logger.debug({ event: 'CACHE_CONNECTION_ERROR', err: err.message }, 'redis error');
    });

    // Non-critical: Redis down marks readiness "degraded" but never takes the API out of rotation.
    health.register({ name: 'redis', critical: false, check: () => this.ping() });
  }

  async lookup(shortCode: string): Promise<CacheLookup> {
    const values = await this.run('get', (r) => r.mget(urlKey(shortCode), notFoundKey(shortCode)));
    if (values === undefined) return { kind: 'miss' };

    const [raw, negative] = values;
    if (raw !== null) {
      const record = parseRecord(raw);
      if (record) {
        this.metrics.cacheOperations.inc({ op: 'get', result: 'hit' });
        this.logger.debug({ event: 'CACHE_HIT', shortCode }, 'cache hit');
        return { kind: 'hit', record };
      }
      // Corrupt or foreign value: treat as a miss so the database repopulates it.
      this.logger.warn(
        { event: 'CACHE_ERROR', shortCode, reason: 'unparseable' },
        'bad cache entry',
      );
    }
    if (negative !== null) {
      this.metrics.cacheOperations.inc({ op: 'get', result: 'negative_hit' });
      this.logger.debug({ event: 'NEGATIVE_CACHE_HIT', shortCode }, 'negative cache hit');
      return { kind: 'negative' };
    }

    this.metrics.cacheOperations.inc({ op: 'get', result: 'miss' });
    this.logger.debug({ event: 'CACHE_MISS', shortCode }, 'cache miss');
    return { kind: 'miss' };
  }

  async store(shortCode: string, record: CachedUrl, now: Date = new Date()): Promise<void> {
    const ttl = cacheTtlSeconds(record, this.ttlSeconds, now);
    if (ttl === null) {
      if (this.enabled) this.metrics.cacheOperations.inc({ op: 'set', result: 'skipped' });
      return;
    }
    const value = JSON.stringify({
      originalUrl: record.originalUrl,
      expiresAt: toIso(record.expiresAt),
      deletedAt: null,
    });
    await this.run('set', (r) => r.set(urlKey(shortCode), value, 'EX', ttl), true);
  }

  async storeNegative(shortCode: string): Promise<void> {
    await this.run(
      'set_negative',
      (r) => r.set(notFoundKey(shortCode), '1', 'EX', this.negativeTtlSeconds),
      true,
    );
  }

  /** Called on create so a code probed just before it was issued resolves immediately. */
  async clearNegative(shortCode: string): Promise<void> {
    await this.run('del_negative', (r) => r.del(notFoundKey(shortCode)), true);
  }

  /**
   * Removes the positive entry. Returns false when the delete could not be confirmed, so the
   * caller can log CACHE_INVALIDATION_FAILED; the entry then expires within CACHE_TTL_SECONDS.
   *
   * Always attempts Redis, even with the breaker open. The breaker can stay open for up to
   * CACHE_BREAKER_RESET_MS after Redis has recovered; skipping the DEL in that window left a
   * deleted URL redirecting from cache for up to an hour (found in Docker verification).
   * Deletes are rare, and the attempt is still bounded by the command timeout.
   */
  async invalidate(shortCode: string): Promise<boolean> {
    if (!this.enabled) return true;
    const result = await this.run('del', (r) => r.del(urlKey(shortCode)), true, true);
    return result !== undefined;
  }

  /** Direct check that bypasses the breaker so readiness reflects reality. */
  async ping(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  get breakerState(): BreakerState {
    return this.breaker.state;
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  /**
   * Runs one Redis command through the breaker. Returns `undefined` when Redis was skipped or
   * failed; never throws. Successful writes are counted here, reads in `lookup`.
   *
   * `force` skips the breaker check for correctness-critical writes. Its outcome still feeds the
   * breaker, so a successful forced command closes an open breaker early.
   */
  private async run<T>(
    op: string,
    command: (redis: CacheRedisClient) => Promise<T>,
    countSuccess = false,
    force = false,
  ): Promise<T | undefined> {
    if (!this.redis) return undefined;
    if (!force && !this.breaker.canRequest()) {
      this.metrics.cacheOperations.inc({ op, result: 'bypass' });
      return undefined;
    }
    try {
      const result = await command(this.redis);
      this.breaker.recordSuccess();
      if (countSuccess) this.metrics.cacheOperations.inc({ op, result: 'ok' });
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      this.metrics.cacheOperations.inc({ op, result: 'error' });
      this.logger.warn(
        { event: 'CACHE_ERROR', op, err: err instanceof Error ? err.message : String(err) },
        'cache operation failed',
      );
      return undefined;
    }
  }

  private onBreakerChange(from: BreakerState, to: BreakerState): void {
    this.metrics.cacheBreakerState.set(BREAKER_GAUGE[to]);
    if (to === 'open') {
      this.logger.warn(
        { event: 'CACHE_BREAKER_OPEN', from },
        'cache breaker opened; bypassing Redis',
      );
    } else if (to === 'closed') {
      this.logger.info({ event: 'CACHE_BREAKER_CLOSED', from }, 'cache breaker closed');
    } else {
      this.logger.info({ event: 'CACHE_BREAKER_HALF_OPEN', from }, 'cache breaker probing');
    }
  }
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** Strict parse: anything unexpected is treated as absent rather than trusted. */
export function parseRecord(raw: string): CachedUrl | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.originalUrl !== 'string' || o.originalUrl.length === 0) return null;
  if (!(
    o.expiresAt === null ||
    (typeof o.expiresAt === 'string' && !Number.isNaN(Date.parse(o.expiresAt)))
  )) {
    return null;
  }
  if (!(o.deletedAt === null || typeof o.deletedAt === 'string')) return null;
  return { originalUrl: o.originalUrl, expiresAt: o.expiresAt, deletedAt: o.deletedAt };
}
