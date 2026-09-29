import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import type { Env } from '../config/env.schema';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Prisma 7 client wired to node-postgres through the driver adapter.
 * The pool is owned here so its stats can feed metrics and so shutdown is explicit.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;

  constructor(
    config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    const pool = new Pool({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    const adapter = new PrismaPg(pool, {
      onPoolError: (err) => logger.error({ err, event: 'DB_POOL_ERROR' }, 'pg pool error'),
    });
    super({ adapter });
    this.pool = pool;
    logger.setContext(PrismaService.name);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.info({ event: 'DB_CONNECTED' }, 'database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end().catch(() => undefined);
    this.logger.info({ event: 'DB_DISCONNECTED' }, 'database disconnected');
  }

  /** Cheap liveness probe used by readiness checks. Rejects on failure or after `timeoutMs`. */
  async ping(timeoutMs = 1_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`database ping timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([this.$queryRaw`SELECT 1`, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
