export type UrlStatus = 'active' | 'expired' | 'deleted';

export interface UrlLifecycle {
  expiresAt: Date | string | null;
  deletedAt: Date | string | null;
}

/**
 * The single place that decides whether a short URL may redirect. The info endpoint uses it now;
 * the redirect path will apply it to both cached and database records so they can never disagree.
 * Deletion wins over expiry: a deleted URL stays "deleted" after its expiry passes.
 */
export function urlStatus(record: UrlLifecycle, now: Date = new Date()): UrlStatus {
  if (record.deletedAt !== null) return 'deleted';
  if (record.expiresAt !== null && toTime(record.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
