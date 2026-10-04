import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.schema';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_REDIS, RateLimitService } from './rate-limit.service';

/**
 * The limiter's own connection. Unlike the cache it has no circuit breaker: every write request
 * must get a real answer, and a failure is resolved by the policy's fail mode. It must fail fast
 * so a closed-mode 503 arrives within RATE_LIMIT_COMMAND_TIMEOUT_MS rather than hanging.
 */
export function createRateLimitRedis(config: ConfigService<Env, true>): Redis | null {
  if (!config.get('RATE_LIMIT_ENABLED', { infer: true })) return null;
  return new Redis(config.get('REDIS_URL', { infer: true }), {
    commandTimeout: config.get('RATE_LIMIT_COMMAND_TIMEOUT_MS', { infer: true }),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 100, 2_000),
    connectionName: 'url-shortener-ratelimit',
  });
}

@Module({
  providers: [
    { provide: RATE_LIMIT_REDIS, inject: [ConfigService], useFactory: createRateLimitRedis },
    RateLimitService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {}
