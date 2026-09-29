import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { issueDeleteToken, verifyDeleteToken } from './delete-token';
import type { CreatedUrlDto, UrlInfoDto } from './dto/url-response.dto';
import { generateShortCode, isWellFormedShortCode } from './short-code';
import { urlStatus } from './url-status';
import { validateCreateUrlInput } from './url-validation';

const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class UrlsService {
  private readonly baseUrl: string;
  private readonly codeLength: number;
  private readonly maxAttempts: number;
  private readonly maxUrlLength: number;
  private readonly maxExpiryDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    config: ConfigService<Env, true>,
  ) {
    this.logger.setContext(UrlsService.name);
    this.baseUrl = config.get('BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.codeLength = config.get('SHORT_CODE_LENGTH', { infer: true });
    this.maxAttempts = config.get('SHORT_CODE_MAX_ATTEMPTS', { infer: true });
    this.maxUrlLength = config.get('MAX_URL_LENGTH', { infer: true });
    this.maxExpiryDays = config.get('MAX_EXPIRY_DAYS', { infer: true });
  }

  async create(body: unknown): Promise<CreatedUrlDto> {
    const result = validateCreateUrlInput(body, {
      baseUrl: this.baseUrl,
      maxUrlLength: this.maxUrlLength,
      maxExpiryDays: this.maxExpiryDays,
    });
    if (!result.ok) throw new BadRequestException(result.errors);

    const { url, expiresAt } = result.value;
    const { token, hash } = issueDeleteToken();

    // Uniqueness is enforced by the database constraint, not by a check-then-insert race.
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const shortCode = generateShortCode(this.codeLength);
      try {
        const row = await this.prisma.url.create({
          data: { shortCode, originalUrl: url, expiresAt, deleteTokenHash: hash },
        });
        this.logger.info(
          { event: 'URL_CREATED', shortCode, hasExpiry: expiresAt !== null, attempt },
          'short url created',
        );
        return {
          id: row.id,
          shortCode: row.shortCode,
          shortUrl: `${this.baseUrl}/${row.shortCode}`,
          originalUrl: row.originalUrl,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          deleteToken: token,
        };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        this.logger.warn({ event: 'SHORT_CODE_COLLISION', attempt }, 'short code collision');
      }
    }

    this.logger.error(
      { event: 'SHORT_CODE_EXHAUSTED', attempts: this.maxAttempts },
      'could not allocate a unique short code',
    );
    throw new InternalServerErrorException();
  }

  async getInfo(shortCode: string): Promise<UrlInfoDto> {
    // Malformed codes cannot exist, so they never reach the database.
    if (!isWellFormedShortCode(shortCode)) throw new NotFoundException('Short URL not found');

    const row = await this.prisma.url.findUnique({ where: { shortCode } });
    if (!row) throw new NotFoundException('Short URL not found');

    return {
      shortCode: row.shortCode,
      originalUrl: row.originalUrl,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      clickCount: row.clickCount,
      status: urlStatus(row),
    };
  }

  /**
   * Soft delete (D5). Order of checks follows section 12: unknown is 404, a bad token is 403.
   * Repeating a delete with a valid token is a no-op success, so clients can retry safely.
   */
  async delete(shortCode: string, presentedToken: unknown): Promise<void> {
    if (!isWellFormedShortCode(shortCode)) throw new NotFoundException('Short URL not found');

    const row = await this.prisma.url.findUnique({
      where: { shortCode },
      select: { id: true, deleteTokenHash: true, deletedAt: true },
    });
    if (!row) throw new NotFoundException('Short URL not found');

    if (!verifyDeleteToken(presentedToken, row.deleteTokenHash)) {
      this.logger.warn({ event: 'DELETE_TOKEN_REJECTED', shortCode }, 'delete token rejected');
      throw new ForbiddenException('Invalid or missing delete token');
    }

    if (row.deletedAt !== null) return;

    // Conditional on deletedAt still being null, so two concurrent deletes set it once.
    const { count } = await this.prisma.url.updateMany({
      where: { id: row.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count > 0) {
      this.logger.info({ event: 'URL_DELETED', shortCode }, 'short url deleted');
    }
    // Milestone 4: invalidate url:{shortCode} here.
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION;
}
