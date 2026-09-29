import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { isWellFormedShortCode } from '../urls/short-code';
import { UrlLifecycle, urlStatus } from '../urls/url-status';

/** Everything the redirect decision needs. Milestone 4 caches exactly this shape. */
export interface RedirectRecord extends UrlLifecycle {
  originalUrl: string;
}

export type RedirectResolution =
  | { kind: 'redirect'; location: string }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'deleted' };

/**
 * Resolves a short code to a redirect decision. Framework-free result type so the controller
 * owns HTTP concerns and Milestone 4 can put the cache in front of `lookup` without touching them.
 */
@Injectable()
export class RedirectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedirectService.name);
  }

  async resolve(shortCode: string, now: Date = new Date()): Promise<RedirectResolution> {
    // Malformed and reserved codes cannot exist; this also absorbs favicon.ico and similar noise.
    if (!isWellFormedShortCode(shortCode)) return { kind: 'not_found' };

    const record = await this.lookup(shortCode);
    if (!record) {
      this.logger.info({ event: 'URL_NOT_FOUND', shortCode }, 'short code not found');
      return { kind: 'not_found' };
    }

    // The shared status function, so cached and database records can never disagree.
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
    this.logger.info({ event: 'URL_REDIRECTED', shortCode }, 'redirecting');
    return { kind: 'redirect', location: record.originalUrl };
  }

  private lookup(shortCode: string): Promise<RedirectRecord | null> {
    return this.prisma.url.findUnique({
      where: { shortCode },
      select: { originalUrl: true, expiresAt: true, deletedAt: true },
    });
  }
}
