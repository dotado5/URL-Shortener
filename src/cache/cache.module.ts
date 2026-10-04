import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.schema';
import { CACHE_REDIS, CacheService } from './cache.service';

/**
 * The cache's own Redis connection, tuned to fail fast. BullMQ (Milestone 6) and the rate
 * limiter (Milestone 5) get separate connections because they need different behaviour.
 */
export function createCacheRedis(config: ConfigService<Env, true>): Redis | null {
  if (!config.get('CACHE_ENABLED', { infer: true })) return null;
  return new Redis(config.get('REDIS_URL', { infer: true }), {
    commandTimeout: config.get('CACHE_COMMAND_TIMEOUT_MS', { infer: true }),
    // Fail immediately while disconnected instead of queueing behind a dead connection.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 2_000,
    // Keep reconnecting in the background, never more than 2s apart.
    retryStrategy: (times) => Math.min(times * 100, 2_000),
    connectionName: 'url-shortener-cache',
  });
}

@Global()
@Module({
  providers: [
    { provide: CACHE_REDIS, inject: [ConfigService], useFactory: createCacheRedis },
    CacheService,
  ],
  exports: [CacheService],
})
export class CacheModule {}
