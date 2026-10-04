import { randomBytes } from 'node:crypto';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { hashIp } from '../common/utils/ip';
import type { Env } from '../config/env.schema';
import { MetricsService } from '../metrics/metrics.service';
import {
  RATE_LIMIT_ENV_KEYS,
  RateLimitEnv,
  RateLimitPolicy,
  RateLimitPolicyName,
  buildPolicies,
} from './rate-limit.policies';

export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');

/**
 * Sliding-window log in one atomic script (section 18). Check and increment cannot race because
 * Redis runs the script to completion before any other command. Time comes from Redis, not from
 * each API instance's clock, so skew between instances cannot widen the window.
 *
 * Only allowed requests are recorded; hammering while blocked does not extend the block.
 * Returns { allowed (0|1), remaining, msUntilOldestLeavesWindow }.
 */
export const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local max = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])

local allowed = 0
if count < max then
  redis.call('ZADD', KEYS[1], now, now .. '-' .. ARGV[3])
  count = count + 1
  allowed = 1
end
redis.call('PEXPIRE', KEYS[1], window)

local reset = window
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if oldest[2] then reset = tonumber(oldest[2]) + window - now end
return { allowed, max - count, reset }
`;

type SlidingWindowClient = Redis & {
  slidingWindow(key: string, windowMs: number, max: number, member: string): Promise<number[]>;
};

export type RateLimitDecision =
  | {
      kind: 'decided';
      allowed: boolean;
      limit: number;
      remaining: number;
      /** Whole seconds until a slot frees up. Used for RateLimit-Reset and Retry-After. */
      resetSeconds: number;
    }
  /** Redis failed or timed out. The policy's fail mode decides. */
  | { kind: 'unavailable'; policy: RateLimitPolicy }
  | { kind: 'disabled' };

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  readonly policies: Record<RateLimitPolicyName, RateLimitPolicy>;
  private readonly enabled: boolean;
  private readonly secret: string;

  constructor(
    @Inject(RATE_LIMIT_REDIS) private readonly redis: Redis | null,
    config: ConfigService<Env, true>,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RateLimitService.name);
    this.enabled = config.get('RATE_LIMIT_ENABLED', { infer: true }) && redis !== null;
    this.secret = config.get('IP_HASH_SECRET', { infer: true });
    const env = Object.fromEntries(
      RATE_LIMIT_ENV_KEYS.map((k) => [k, config.get(k, { infer: true })]),
    ) as RateLimitEnv;
    this.policies = buildPolicies(env);

    if (redis) {
      redis.defineCommand('slidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
      // Required: an unhandled 'error' event would crash the process during a Redis outage.
      redis.on('error', (err: Error) =>
        this.logger.debug({ event: 'RATE_LIMIT_REDIS_ERROR', err: err.message }, 'redis error'),
      );
    }
  }

  /**
   * The key holds an HMAC of the IP, never the IP itself (D9): `rate-limit:{policy}:{hash}`.
   */
  keyFor(policy: RateLimitPolicyName, ip: string): string {
    return `rate-limit:${policy}:${hashIp(ip, this.secret)}`;
  }

  async consume(policyName: RateLimitPolicyName, ip: string): Promise<RateLimitDecision> {
    if (!this.enabled || !this.redis) return { kind: 'disabled' };
    const policy = this.policies[policyName];

    try {
      const member = randomBytes(6).toString('hex');
      const [allowed, remaining, resetMs] = await (this.redis as SlidingWindowClient).slidingWindow(
        this.keyFor(policyName, ip),
        policy.windowSeconds * 1000,
        policy.max,
        member,
      );
      const decision = {
        kind: 'decided' as const,
        allowed: allowed === 1,
        limit: policy.max,
        remaining: Math.max(0, remaining),
        resetSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
      };
      this.metrics.rateLimitDecisions.inc({
        route: policyName,
        result: decision.allowed ? 'allowed' : 'blocked',
      });
      return decision;
    } catch (err) {
      this.metrics.rateLimitDecisions.inc({ route: policyName, result: 'unavailable' });
      this.logger.warn(
        {
          event: 'RATE_LIMIT_UNAVAILABLE',
          policy: policyName,
          failMode: policy.failMode,
          err: err instanceof Error ? err.message : String(err),
        },
        'rate limiter unavailable',
      );
      return { kind: 'unavailable', policy };
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
