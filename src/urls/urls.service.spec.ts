import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { hashDeleteToken, issueDeleteToken } from './delete-token';
import { UrlsService, isUniqueViolation } from './urls.service';

const CONFIG: Partial<Env> = {
  BASE_URL: 'https://short.ly/',
  SHORT_CODE_LENGTH: 7,
  SHORT_CODE_MAX_ATTEMPTS: 3,
  MAX_URL_LENGTH: 2048,
  MAX_EXPIRY_DAYS: 3650,
};

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on shortCode', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['shortCode'] },
  });
}

interface Harness {
  service: UrlsService;
  create: jest.Mock;
  findUnique: jest.Mock;
  updateMany: jest.Mock;
  logs: { level: string; obj: Record<string, unknown> }[];
}

function makeService(): Harness {
  const create = jest.fn();
  const findUnique = jest.fn();
  const updateMany = jest.fn();
  const prisma = { url: { create, findUnique, updateMany } } as unknown as PrismaService;

  const logs: Harness['logs'] = [];
  const record = (level: string) => (obj: Record<string, unknown>) => logs.push({ level, obj });
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(record('info')),
    warn: jest.fn(record('warn')),
    error: jest.fn(record('error')),
  } as unknown as PinoLogger;

  const config = {
    get: (key: keyof Env) => CONFIG[key],
  } as unknown as ConfigService<Env, true>;

  return {
    service: new UrlsService(prisma, logger, config),
    create,
    findUnique,
    updateMany,
    logs,
  };
}

function rowFrom(data: Record<string, unknown>) {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    createdAt: new Date('2026-09-29T12:00:00.000Z'),
    updatedAt: new Date('2026-09-29T12:00:00.000Z'),
    deletedAt: null,
    clickCount: 0,
    isActive: true,
    ...data,
  };
}

describe('UrlsService.create', () => {
  it('persists and returns the short URL with a delete token whose hash is stored', async () => {
    const h = makeService();
    h.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(rowFrom(data)),
    );

    const out = await h.service.create({ url: 'https://example.com/path' });

    expect(out.shortCode).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(out.shortUrl).toBe(`https://short.ly/${out.shortCode}`);
    expect(out.originalUrl).toBe('https://example.com/path');
    expect(out.expiresAt).toBeNull();
    expect(out.createdAt).toBe('2026-09-29T12:00:00.000Z');

    const data = h.create.mock.calls[0][0].data;
    expect(data.deleteTokenHash).toBe(hashDeleteToken(out.deleteToken));
    expect(data).not.toHaveProperty('deleteToken');
    expect(JSON.stringify(data)).not.toContain(out.deleteToken);
  });

  it('strips the trailing slash from BASE_URL when building shortUrl', async () => {
    const h = makeService();
    h.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(rowFrom(data)),
    );
    const out = await h.service.create({ url: 'https://example.com' });
    expect(out.shortUrl).not.toContain('//' + out.shortCode);
  });

  it('rejects invalid input with 400 and every error message, without touching the database', async () => {
    const h = makeService();
    const err = await h.service
      .create({ url: 'ftp://example.com', expiresAt: 'soon' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    const response = (err as BadRequestException).getResponse() as { message: string[] };
    expect(response.message).toHaveLength(2);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('rejects a URL pointing at BASE_URL', async () => {
    const h = makeService();
    await expect(h.service.create({ url: 'https://short.ly/abc1234' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('retries with a new code after a unique-constraint collision', async () => {
    const h = makeService();
    h.create
      .mockRejectedValueOnce(uniqueViolation())
      .mockImplementationOnce(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(rowFrom(data)),
      );

    const out = await h.service.create({ url: 'https://example.com' });

    expect(h.create).toHaveBeenCalledTimes(2);
    const firstCode = h.create.mock.calls[0][0].data.shortCode;
    const secondCode = h.create.mock.calls[1][0].data.shortCode;
    expect(out.shortCode).toBe(secondCode);
    expect(firstCode).not.toBe(secondCode);
    expect(h.logs.some((l) => l.obj.event === 'SHORT_CODE_COLLISION')).toBe(true);
  });

  it('keeps the same delete token across retries', async () => {
    const h = makeService();
    h.create
      .mockRejectedValueOnce(uniqueViolation())
      .mockImplementationOnce(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(rowFrom(data)),
      );
    const out = await h.service.create({ url: 'https://example.com' });
    const hashes = h.create.mock.calls.map(
      (c: [{ data: { deleteTokenHash: string } }]) => c[0].data.deleteTokenHash,
    );
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(hashDeleteToken(out.deleteToken));
  });

  it('gives up after SHORT_CODE_MAX_ATTEMPTS collisions with a 500 and SHORT_CODE_EXHAUSTED', async () => {
    const h = makeService();
    h.create.mockRejectedValue(uniqueViolation());

    await expect(h.service.create({ url: 'https://example.com' })).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(h.create).toHaveBeenCalledTimes(3);
    expect(h.logs.filter((l) => l.obj.event === 'SHORT_CODE_EXHAUSTED')).toHaveLength(1);
  });

  it('does not retry on errors other than a unique violation', async () => {
    const h = makeService();
    h.create.mockRejectedValue(new Error('connection refused'));

    await expect(h.service.create({ url: 'https://example.com' })).rejects.toThrow(
      'connection refused',
    );
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('never logs the destination URL or the delete token', async () => {
    const h = makeService();
    h.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(rowFrom(data)),
    );
    const out = await h.service.create({ url: 'https://example.com/secret?token=abc' });
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain('example.com');
    expect(logged).not.toContain(out.deleteToken);
  });
});

describe('UrlsService.getInfo', () => {
  const NOW = Date.now();

  it.each(['abc', 'a'.repeat(13), 'bad-code', 'health', 'favicon.ico'])(
    'returns 404 for malformed or reserved %p without a database query',
    async (code) => {
      const h = makeService();
      await expect(h.service.getInfo(code)).rejects.toBeInstanceOf(NotFoundException);
      expect(h.findUnique).not.toHaveBeenCalled();
    },
  );

  it('returns 404 for an unknown code', async () => {
    const h = makeService();
    h.findUnique.mockResolvedValue(null);
    await expect(h.service.getInfo('abc1234')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['active', { expiresAt: null, deletedAt: null }],
    ['expired', { expiresAt: new Date(NOW - 1000), deletedAt: null }],
    ['deleted', { expiresAt: null, deletedAt: new Date(NOW - 1000) }],
  ])('reports status %s', async (status, lifecycle) => {
    const h = makeService();
    h.findUnique.mockResolvedValue(
      rowFrom({
        shortCode: 'abc1234',
        originalUrl: 'https://example.com/',
        clickCount: 7,
        ...lifecycle,
      }),
    );
    const info = await h.service.getInfo('abc1234');
    expect(info.status).toBe(status);
    expect(info.clickCount).toBe(7);
    expect(info).not.toHaveProperty('deleteTokenHash');
    expect(info).not.toHaveProperty('id');
  });
});

describe('isUniqueViolation', () => {
  it('matches P2002 only', () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
    expect(
      isUniqueViolation(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' }),
      ),
    ).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
  });
});

describe('UrlsService.delete', () => {
  const { token, hash } = issueDeleteToken();
  const row = (deletedAt: Date | null = null) => ({
    id: '00000000-0000-4000-8000-000000000000',
    deleteTokenHash: hash,
    deletedAt,
  });

  it('soft-deletes with a valid token, conditional on not already being deleted', async () => {
    const h = makeService();
    h.findUnique.mockResolvedValue(row());
    h.updateMany.mockResolvedValue({ count: 1 });

    await expect(h.service.delete('abc1234', token)).resolves.toBeUndefined();

    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: row().id, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(h.logs.map((l) => l.obj.event)).toEqual(['URL_DELETED']);
  });

  it('is idempotent: an already-deleted URL with a valid token succeeds without writing', async () => {
    const h = makeService();
    h.findUnique.mockResolvedValue(row(new Date()));
    await expect(h.service.delete('abc1234', token)).resolves.toBeUndefined();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('does not log a second URL_DELETED when a concurrent delete won the race', async () => {
    const h = makeService();
    h.findUnique.mockResolvedValue(row());
    h.updateMany.mockResolvedValue({ count: 0 });
    await h.service.delete('abc1234', token);
    expect(h.logs.filter((l) => l.obj.event === 'URL_DELETED')).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong', issueDeleteToken().token],
    ['the stored hash itself', hash],
  ])('returns 403 for a %s token and writes nothing', async (_name, presented) => {
    const h = makeService();
    h.findUnique.mockResolvedValue(row());
    await expect(h.service.delete('abc1234', presented)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.logs.map((l) => l.obj.event)).toEqual(['DELETE_TOKEN_REJECTED']);
  });

  it('checks the token even for an already-deleted URL', async () => {
    const h = makeService();
    h.findUnique.mockResolvedValue(row(new Date()));
    await expect(h.service.delete('abc1234', 'wrong')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 404 for an unknown code before looking at the token', async () => {
    const h = makeService();
    h.findUnique.mockResolvedValue(null);
    await expect(h.service.delete('abc1234', undefined)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['abc', 'health', 'bad-code'])(
    'returns 404 for malformed %p without a query',
    async (code) => {
      const h = makeService();
      await expect(h.service.delete(code, token)).rejects.toBeInstanceOf(NotFoundException);
      expect(h.findUnique).not.toHaveBeenCalled();
    },
  );

  it('never logs the token', async () => {
    const h = makeService();
    h.findUnique.mockResolvedValue(row());
    h.updateMany.mockResolvedValue({ count: 1 });
    await h.service.delete('abc1234', token);
    await h.service.delete('abc1234', 'wrong-token-value').catch(() => undefined);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('wrong-token-value');
  });
});
