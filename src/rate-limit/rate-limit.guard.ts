import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { clientIp } from '../common/utils/ip';
import { RATE_LIMIT_POLICY, RateLimitPolicyName } from './rate-limit.policies';
import { RateLimitService } from './rate-limit.service';

export const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Global guard. Handlers without @RateLimit pass straight through, so the redirect route pays
 * one metadata lookup and nothing else.
 *
 * Runs before validation, so malformed requests still spend quota; an attacker cannot probe
 * for free with bad bodies.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RateLimitGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policyName = this.reflector.get<RateLimitPolicyName | undefined>(
      RATE_LIMIT_POLICY,
      context.getHandler(),
    );
    if (!policyName || context.getType() !== 'http') return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const decision = await this.limiter.consume(policyName, clientIp(req));

    if (decision.kind === 'disabled') return true;

    if (decision.kind === 'unavailable') {
      if (decision.policy.failMode === 'open') return true;
      res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_SECONDS));
      throw new ServiceUnavailableException('Rate limiter unavailable. Please try again shortly.');
    }

    // IETF RateLimit header fields draft; sent on every limited response, not only on 429.
    res.setHeader('RateLimit-Limit', String(decision.limit));
    res.setHeader('RateLimit-Remaining', String(decision.remaining));
    res.setHeader('RateLimit-Reset', String(decision.resetSeconds));

    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.resetSeconds));
      this.logger.info(
        { event: 'RATE_LIMIT_EXCEEDED', policy: policyName, retryAfter: decision.resetSeconds },
        'rate limit exceeded',
      );
      throw new HttpException(
        'Too many requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
