import { ExecutionContext, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { PinoLogger } from 'nestjs-pino';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitPolicy } from './rate-limit.policies';
import type { RateLimitDecision, RateLimitService } from './rate-limit.service';

function setup(policy: string | undefined, decision: RateLimitDecision) {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
  const req = { ip: '::ffff:203.0.113.9', socket: {} };
  const ctx = {
    getType: () => 'http',
    getHandler: () => () => undefined,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  const consume = jest.fn().mockResolvedValue(decision);
  const logs: Record<string, unknown>[] = [];
  const guard = new RateLimitGuard(
    { get: () => policy } as unknown as Reflector,
    { consume } as unknown as RateLimitService,
    {
      setContext: jest.fn(),
      info: (o: Record<string, unknown>) => logs.push(o),
    } as unknown as PinoLogger,
  );
  return { guard, ctx, headers, consume, logs };
}

const policy = (failMode: 'open' | 'closed'): RateLimitPolicy => ({
  name: 'create',
  max: 10,
  windowSeconds: 60,
  failMode,
});

describe('RateLimitGuard', () => {
  it('ignores handlers without a policy and never touches Redis', async () => {
    const { guard, ctx, consume, headers } = setup(undefined, { kind: 'disabled' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
    expect(headers).toEqual({});
  });

  it('passes the normalised client IP to the limiter', async () => {
    const { guard, ctx, consume } = setup('create', { kind: 'disabled' });
    await guard.canActivate(ctx);
    expect(consume).toHaveBeenCalledWith('create', '203.0.113.9');
  });

  it('allows and sets RateLimit-* headers when under the limit', async () => {
    const { guard, ctx, headers } = setup('create', {
      kind: 'decided',
      allowed: true,
      limit: 10,
      remaining: 7,
      resetSeconds: 42,
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(headers).toEqual({
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '7',
      'RateLimit-Reset': '42',
    });
  });

  it('blocks with 429, Retry-After, and a RATE_LIMIT_EXCEEDED event', async () => {
    const { guard, ctx, headers, logs } = setup('create', {
      kind: 'decided',
      allowed: false,
      limit: 10,
      remaining: 0,
      resetSeconds: 17,
    });
    const err = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).message).toBe('Too many requests. Please try again later.');
    expect(headers).toMatchObject({ 'Retry-After': '17', 'RateLimit-Remaining': '0' });
    expect(logs).toEqual([
      expect.objectContaining({ event: 'RATE_LIMIT_EXCEEDED', policy: 'create', retryAfter: 17 }),
    ]);
    expect(JSON.stringify(logs)).not.toContain('203.0.113.9');
  });

  it('fails closed with 503 and Retry-After when Redis is unavailable', async () => {
    const { guard, ctx, headers } = setup('create', {
      kind: 'unavailable',
      policy: policy('closed'),
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(headers).toEqual({ 'Retry-After': '5' });
  });

  it('fails open when the policy says so', async () => {
    const { guard, ctx, headers } = setup('info', { kind: 'unavailable', policy: policy('open') });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(headers).toEqual({});
  });

  it('allows everything when rate limiting is disabled', async () => {
    const { guard, ctx } = setup('create', { kind: 'disabled' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
