import { z } from 'zod';

const booleanString = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const intFromEnv = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max);

/**
 * Every environment variable the application reads, with defaults and constraints.
 * Boot fails with a readable message when validation fails.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intFromEnv(1, 65535).default(3000),
    BASE_URL: z.url(),
    TRUST_PROXY: z.string().default(''),
    BODY_LIMIT: z
      .string()
      .regex(/^\d+(b|kb|mb)$/i, 'e.g. 10kb')
      .default('10kb'),
    CORS_ORIGINS: z.string().default(''),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    SHORT_CODE_LENGTH: intFromEnv(6, 12).default(7),
    SHORT_CODE_MAX_ATTEMPTS: intFromEnv(1, 20).default(5),

    MAX_URL_LENGTH: intFromEnv(64, 2048).default(2048),
    MAX_EXPIRY_DAYS: intFromEnv(1).default(3650),

    CACHE_ENABLED: booleanString.default(true),
    CACHE_TTL_SECONDS: intFromEnv(1).default(3600),
    CACHE_NEGATIVE_TTL_SECONDS: intFromEnv(1).default(60),
    CACHE_COMMAND_TIMEOUT_MS: intFromEnv(1).default(50),
    CACHE_BREAKER_FAILURE_THRESHOLD: intFromEnv(1).default(5),
    CACHE_BREAKER_RESET_MS: intFromEnv(100).default(10_000),

    RATE_LIMIT_ENABLED: booleanString.default(true),
    RATE_LIMIT_FAIL_MODE: z.enum(['closed', 'open']).default('closed'),
    RATE_LIMIT_CREATE_MAX: intFromEnv(1).default(10),
    RATE_LIMIT_CREATE_WINDOW_SECONDS: intFromEnv(1).default(60),
    RATE_LIMIT_DELETE_MAX: intFromEnv(1).default(10),
    RATE_LIMIT_DELETE_WINDOW_SECONDS: intFromEnv(1).default(60),
    RATE_LIMIT_INFO_MAX: intFromEnv(1).default(60),
    RATE_LIMIT_INFO_WINDOW_SECONDS: intFromEnv(1).default(60),

    BULLMQ_ANALYTICS_QUEUE: z.string().min(1).default('url-analytics'),
    BULLMQ_CLEANUP_QUEUE: z.string().min(1).default('url-cleanup'),
    JOB_TIMEOUT_MS: intFromEnv(100).default(10_000),
    CLEANUP_CRON: z.string().min(1).default('*/15 * * * *'),
    CLEANUP_BATCH_SIZE: intFromEnv(1).default(1000),
    ANALYTICS_RETENTION_DAYS: intFromEnv(1).default(90),
    WORKER_HEALTH_PORT: intFromEnv(1, 65535).default(3001),

    IP_HASH_SECRET: z.string().default(''),

    SHUTDOWN_TIMEOUT_MS: intFromEnv(100).default(10_000),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    METRICS_ENABLED: booleanString.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.IP_HASH_SECRET.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['IP_HASH_SECRET'],
          message: 'must be at least 32 characters in production',
        });
      }
      if (env.RATE_LIMIT_FAIL_MODE !== 'closed') {
        ctx.addIssue({
          code: 'custom',
          path: ['RATE_LIMIT_FAIL_MODE'],
          message: 'must be "closed" in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Used by @nestjs/config's `validate` hook. Throws so the process exits before listening. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvValidationError(issues);
  }
  return result.data;
}
