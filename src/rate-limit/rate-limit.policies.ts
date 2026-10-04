import { SetMetadata } from '@nestjs/common';
import type { Env } from '../config/env.schema';

export type RateLimitPolicyName = 'create' | 'delete' | 'info';

export interface RateLimitPolicy {
  name: RateLimitPolicyName;
  max: number;
  windowSeconds: number;
  /** What to do when Redis cannot answer: refuse (closed) or let the request through (open). */
  failMode: 'open' | 'closed';
}

/**
 * Section 18. Writes follow RATE_LIMIT_FAIL_MODE (closed in production, enforced by config
 * validation). The read-only info endpoint always fails open: refusing reads during a Redis
 * outage would protect nothing. Redirects have no application limit at all (D2).
 */
export type RateLimitEnv = Pick<
  Env,
  | 'RATE_LIMIT_CREATE_MAX'
  | 'RATE_LIMIT_CREATE_WINDOW_SECONDS'
  | 'RATE_LIMIT_DELETE_MAX'
  | 'RATE_LIMIT_DELETE_WINDOW_SECONDS'
  | 'RATE_LIMIT_INFO_MAX'
  | 'RATE_LIMIT_INFO_WINDOW_SECONDS'
  | 'RATE_LIMIT_FAIL_MODE'
>;

export const RATE_LIMIT_ENV_KEYS: (keyof RateLimitEnv)[] = [
  'RATE_LIMIT_CREATE_MAX',
  'RATE_LIMIT_CREATE_WINDOW_SECONDS',
  'RATE_LIMIT_DELETE_MAX',
  'RATE_LIMIT_DELETE_WINDOW_SECONDS',
  'RATE_LIMIT_INFO_MAX',
  'RATE_LIMIT_INFO_WINDOW_SECONDS',
  'RATE_LIMIT_FAIL_MODE',
];

export function buildPolicies(env: RateLimitEnv): Record<RateLimitPolicyName, RateLimitPolicy> {
  return {
    create: {
      name: 'create',
      max: env.RATE_LIMIT_CREATE_MAX,
      windowSeconds: env.RATE_LIMIT_CREATE_WINDOW_SECONDS,
      failMode: env.RATE_LIMIT_FAIL_MODE,
    },
    delete: {
      name: 'delete',
      max: env.RATE_LIMIT_DELETE_MAX,
      windowSeconds: env.RATE_LIMIT_DELETE_WINDOW_SECONDS,
      failMode: env.RATE_LIMIT_FAIL_MODE,
    },
    info: {
      name: 'info',
      max: env.RATE_LIMIT_INFO_MAX,
      windowSeconds: env.RATE_LIMIT_INFO_WINDOW_SECONDS,
      failMode: 'open',
    },
  };
}

export const RATE_LIMIT_POLICY = 'rate-limit:policy';

/** Marks a handler as rate limited under the named policy. Undecorated handlers are not limited. */
export const RateLimit = (policy: RateLimitPolicyName) => SetMetadata(RATE_LIMIT_POLICY, policy);
