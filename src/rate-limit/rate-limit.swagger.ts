import { applyDecorators } from '@nestjs/common';
import {
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ErrorDto } from '../urls/dto/url-response.dto';
import { RateLimit, RateLimitPolicyName } from './rate-limit.policies';

const RATE_HEADERS = {
  'RateLimit-Limit': { description: 'Requests allowed per window', schema: { type: 'integer' } },
  'RateLimit-Remaining': {
    description: 'Requests left in the window',
    schema: { type: 'integer' },
  },
  'RateLimit-Reset': {
    description: 'Seconds until a request slot frees up',
    schema: { type: 'integer' },
  },
};

/**
 * Applies the policy and documents its behaviour in one place, so the docs cannot drift from
 * which routes are actually limited.
 */
export function RateLimited(policy: RateLimitPolicyName, failsClosed: boolean) {
  const decorators = [
    RateLimit(policy),
    ApiResponse({
      status: 'default',
      description: 'Every response from this route carries the RateLimit-* headers.',
      headers: RATE_HEADERS,
    }),
    ApiTooManyRequestsResponse({
      type: ErrorDto,
      description: 'Per-IP limit exceeded (sliding window). Retry after the given seconds.',
      headers: {
        ...RATE_HEADERS,
        'Retry-After': { description: 'Seconds to wait', schema: { type: 'integer' } },
      },
    }),
  ];
  if (failsClosed) {
    decorators.push(
      ApiServiceUnavailableResponse({
        type: ErrorDto,
        description:
          'The rate limiter cannot reach Redis. Writes fail closed rather than go unprotected.',
        headers: { 'Retry-After': { schema: { type: 'integer', example: 5 } } },
      }),
    );
  }
  return applyDecorators(...decorators);
}
