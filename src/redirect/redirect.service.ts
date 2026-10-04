import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CacheService, CachedUrl } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { isWellFormedShortCode } from '../urls/short-code';
import { urlStatus } from '../urls/url-status';

/** Everything the redirect decision needs. Identical whether it came from Redis or PostgreSQL. */
export type RedirectRecord = CachedUrl;

export type RedirectResolution =
  | { kind: 'redirect'; location: string }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'deleted' };

/**
 * Resolves a short code to a redirect decision (section 9):
 *
 *   malformed? → 404, no I/O
 *   Redis MGET url:{code} + url:notfound:{code}   (one round trip)
 *     negative → 404
 *     hit      → validate → decision
 *     miss / Redis unavailable → PostgreSQL
 *       none  → write negative entry → 404
 *       found → populate cache (TTL capped at expiry) → validate → decision
 *
 * Validation runs on every path through the shared `urlStatus`, so a cached record can never
 * redirect after its expiry even if its TTL were wrong.
 */
@Injectable()
export class RedirectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedirectService.name);
  }

  async resolve(shortCode: string, now: Date = new Date()): Promise<RedirectResolution> {
    // Malformed and reserved codes cannot exist; this also absorbs favicon.ico and similar noise
    // without creating negative-cache entries for junk paths.
    if (!isWellFormedShortCode(shortCode)) return { kind: 'not_found' };

    const cached = await this.cache.lookup(shortCode);
    if (cached.kind === 'negative') return { kind: 'not_found' };

    let record: RedirectRecord | null;
    if (cached.kind === 'hit') {
      record = cached.record;
    } else {
      record = await this.lookup(shortCode);
      if (!record) {
        this.logger.info({ event: 'URL_NOT_FOUND', shortCode }, 'short code not found');
        await this.cache.storeNegative(shortCode);
        return { kind: 'not_found' };
      }
      // Deleted and expired records are skipped inside `store`.
      await this.cache.store(shortCode, record, now);
    }

    const status = urlStatus(record, now);
    if (status === 'expired') {
      this.logger.info({ event: 'URL_EXPIRED', shortCode }, 'short url expired');
      return { kind: 'expired' };
    }
    if (status === 'deleted') {
      this.logger.info({ event: 'URL_DELETED_ACCESSED', shortCode }, 'deleted short url requested');
      return { kind: 'deleted' };
    }

    // Destination deliberately not logged: query strings often carry tokens.
    this.logger.info(
      { event: 'URL_REDIRECTED', shortCode, source: cached.kind === 'hit' ? 'cache' : 'db' },
      'redirecting',
    );
    return { kind: 'redirect', location: record.originalUrl };
  }

  private lookup(shortCode: string): Promise<RedirectRecord | null> {
    return this.prisma.url.findUnique({
      where: { shortCode },
      select: { originalUrl: true, expiresAt: true, deletedAt: true },
    });
  }
}
