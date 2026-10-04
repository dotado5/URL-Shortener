import type { UrlLifecycle } from '../urls/url-status';

/**
 * Seconds to keep a URL in the cache, or `null` for "do not cache".
 *
 * - No expiry: the configured default.
 * - With expiry: never longer than the time left, so a TTL bug cannot keep an expired record
 *   around. Rounded down so the entry disappears at or before the expiry instant.
 * - Already expired, under a second left, or deleted: not cached at all.
 *
 * Read-time validation still runs on every hit; this cap is defence in depth (section 15).
 */
export function cacheTtlSeconds(
  record: UrlLifecycle,
  defaultTtlSeconds: number,
  now: Date = new Date(),
): number | null {
  if (record.deletedAt !== null) return null;
  if (record.expiresAt === null) return defaultTtlSeconds;

  const expiresAt =
    record.expiresAt instanceof Date ? record.expiresAt.getTime() : Date.parse(record.expiresAt);
  const secondsLeft = Math.floor((expiresAt - now.getTime()) / 1000);
  if (secondsLeft < 1) return null;
  return Math.min(defaultTtlSeconds, secondsLeft);
}
