import { z } from 'zod';
import { SHORT_CODE_PATTERN } from '../../urls/short-code';

export const ANALYTICS_JOB_NAME = 'click';

/** Truncation limit for free-text headers; matches the VARCHAR(512) columns. */
export const HEADER_MAX_LENGTH = 512;

/**
 * The contract between the API (producer) and the worker (consumer), section 21.
 * The worker re-validates every payload: a job that fails this schema can never succeed,
 * so it is failed permanently instead of retried.
 */
export const clickEventSchema = z.object({
  eventId: z.uuid(),
  shortCode: z.string().regex(SHORT_CODE_PATTERN),
  timestamp: z.iso.datetime({ offset: true }),
  userAgent: z.string().max(HEADER_MAX_LENGTH).nullable(),
  referer: z.string().max(HEADER_MAX_LENGTH).nullable(),
  /** HMAC-SHA256 hex of the client IP. The raw IP never enters Redis (D9). */
  ipHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ClickEvent = z.infer<typeof clickEventSchema>;

export function truncateHeader(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return null;
  return v.length > HEADER_MAX_LENGTH ? v.slice(0, HEADER_MAX_LENGTH) : v;
}
