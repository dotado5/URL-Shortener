import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema';
import { MetricsService } from '../metrics/metrics.service';
import { buildPolicies } from './rate-limit.policies';
import { RateLimitService, SLIDING_WINDOW_LUA } from './rate-limit.service';

const CONFIG: Partial<Env> = {
  RATE_LIMIT_ENABLED: true,
  IP_HASH_SECRET: 'x'.repeat(32),
  RATE_LIMIT_CREATE_MAX: 10,
  RATE_LIMIT_CREATE_WINDOW_SECONDS: 60,
  RATE_LIMIT_DELETE_MAX: 5,
  RATE_LIMIT_DELETE_WINDOW_SECONDS: 30,
  RATE_LIMIT_INFO_MAX: 60,
  RATE_LIMIT_INFO_WINDOW_SECONDS: 60,
  RATE_LIMIT_FAIL_MODE: 'closed',
};

function make(slidingWindow: jest.Mock, overrides: Partial<Env> = {}, withRedis = true) {
  const defineCommand = jest.fn();
  const redis = withRedis
    ? ({ defineCommand, on: jest.fn(), slidingWindow } as unknown as Redis)
    : null;
  const cfg = { ...CONFIG, ...overrides };
  const config = { get: (k: keyof Env) => cfg[k] } as unknown as ConfigService<Env, true>;
  const metrics = new MetricsService();
  const logs: Record<string, unknown>[] = [];
  const logger = {
    setContext: jest.fn(),
    warn: (o: Record<string, unknown>) => logs.push(o),
    debug: jest.fn(),
  } as unknown as PinoLogger;
  const service = new RateLimitService(redis, config, metrics, logger);
  const count = async (route: string, result: string) =>
    (await metrics.rateLimitDecisions.get()).values.find(
      (v) => v.labels.route === route && v.labels.result === result,
    )?.value ?? 0;
  return { service, defineCommand, logs, count };
}

describe('RateLimitService', () => {
  it('registers the sliding-window script once', () => {
    const { defineCommand } = make(jest.fn());
    expect(defineCommand).toHaveBeenCalledWith('slidingWindow', {
      numberOfKeys: 1,
      lua: SLIDING_WINDOW_LUA,
    });
  });

  it('calls the script with the policy window in ms, the max, and a unique member', async () => {
    const sw = jest.fn().mockResolvedValue([1, 9, 60_000]);
    const { service } = make(sw);
    await service.consume('create', '203.0.113.9');
    await service.consume('create', '203.0.113.9');
    const [key, windowMs, max, member] = sw.mock.calls[0] as [string, number, number, string];
    expect(key).toBe(service.keyFor('create', '203.0.113.9'));
    expect(windowMs).toBe(60_000);
    expect(max).toBe(10);
    expect(member).not.toBe(sw.mock.calls[1][3]);
  });

  it('keys by policy and HMAC of the IP, never the raw IP', () => {
    const { service } = make(jest.fn());
    const key = service.keyFor('create', '203.0.113.9');
    expect(key).toMatch(/^rate-limit:create:[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113.9');
    expect(service.keyFor('delete', '203.0.113.9')).not.toBe(key);
  });

  it('maps an allowed result', async () => {
    const { service, count } = make(jest.fn().mockResolvedValue([1, 9, 59_500]));
    expect(await service.consume('create', '1.2.3.4')).toEqual({
      kind: 'decided',
      allowed: true,
      limit: 10,
      remaining: 9,
      resetSeconds: 60,
    });
    expect(await count('create', 'allowed')).toBe(1);
  });

  it('maps a blocked result, rounding reset up to at least one second', async () => {
    const { service, count } = make(jest.fn().mockResolvedValue([0, 0, 120]));
    expect(await service.consume('create', '1.2.3.4')).toMatchObject({
      allowed: false,
      remaining: 0,
      resetSeconds: 1,
    });
    expect(await count('create', 'blocked')).toBe(1);
  });

  it('reports unavailable with the policy when Redis fails', async () => {
    const { service, logs, count } = make(
      jest.fn().mockRejectedValue(new Error('Command timed out')),
    );
    const d = await service.consume('delete', '1.2.3.4');
    expect(d).toEqual({ kind: 'unavailable', policy: expect.objectContaining({ name: 'delete' }) });
    expect(logs[0]).toMatchObject({
      event: 'RATE_LIMIT_UNAVAILABLE',
      policy: 'delete',
      failMode: 'closed',
    });
    expect(await count('delete', 'unavailable')).toBe(1);
  });

  it('is disabled when RATE_LIMIT_ENABLED is false', async () => {
    const sw = jest.fn();
    const { service } = make(sw, { RATE_LIMIT_ENABLED: false }, false);
    expect(await service.consume('create', '1.2.3.4')).toEqual({ kind: 'disabled' });
    expect(sw).not.toHaveBeenCalled();
  });
});

describe('buildPolicies', () => {
  it('writes follow RATE_LIMIT_FAIL_MODE; info always fails open', () => {
    const closed = buildPolicies(CONFIG as Env);
    expect(closed.create.failMode).toBe('closed');
    expect(closed.delete.failMode).toBe('closed');
    expect(closed.info.failMode).toBe('open');

    const open = buildPolicies({ ...CONFIG, RATE_LIMIT_FAIL_MODE: 'open' } as Env);
    expect(open.create.failMode).toBe('open');
  });

  it('takes limits and windows from config', () => {
    expect(buildPolicies(CONFIG as Env).delete).toEqual({
      name: 'delete',
      max: 5,
      windowSeconds: 30,
      failMode: 'closed',
    });
  });
});
