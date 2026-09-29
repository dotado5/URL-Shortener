import type { PinoLogger } from 'nestjs-pino';
import type { PrismaService } from '../prisma/prisma.service';
import { RedirectService } from './redirect.service';

const NOW = new Date('2026-09-29T12:00:00.000Z');

function harness(record: Record<string, unknown> | null) {
  const findUnique = jest.fn().mockResolvedValue(record);
  const prisma = { url: { findUnique } } as unknown as PrismaService;
  const logs: Record<string, unknown>[] = [];
  const logger = {
    setContext: jest.fn(),
    info: jest.fn((obj: Record<string, unknown>) => logs.push(obj)),
  } as unknown as PinoLogger;
  return { service: new RedirectService(prisma, logger), findUnique, logs };
}

const active = {
  originalUrl: 'https://example.com/secret?token=abc',
  expiresAt: null,
  deletedAt: null,
};

describe('RedirectService.resolve', () => {
  it('redirects an active URL to its original destination', async () => {
    const h = harness(active);
    await expect(h.service.resolve('abc1234', NOW)).resolves.toEqual({
      kind: 'redirect',
      location: 'https://example.com/secret?token=abc',
    });
  });

  it('selects only the fields the decision needs', async () => {
    const h = harness(active);
    await h.service.resolve('abc1234', NOW);
    expect(h.findUnique).toHaveBeenCalledWith({
      where: { shortCode: 'abc1234' },
      select: { originalUrl: true, expiresAt: true, deletedAt: true },
    });
  });

  it('redirects when expiry is still in the future', async () => {
    const h = harness({ ...active, expiresAt: new Date(NOW.getTime() + 1) });
    expect((await h.service.resolve('abc1234', NOW)).kind).toBe('redirect');
  });

  it('reports expired at and after the expiry instant', async () => {
    expect(
      (await harness({ ...active, expiresAt: NOW }).service.resolve('abc1234', NOW)).kind,
    ).toBe('expired');
    const past = new Date(NOW.getTime() - 1);
    expect(
      (await harness({ ...active, expiresAt: past }).service.resolve('abc1234', NOW)).kind,
    ).toBe('expired');
  });

  it('reports deleted, even when also expired', async () => {
    const past = new Date(NOW.getTime() - 1);
    const h = harness({ ...active, deletedAt: past, expiresAt: past });
    expect((await h.service.resolve('abc1234', NOW)).kind).toBe('deleted');
  });

  it('reports not_found for an unknown code', async () => {
    const h = harness(null);
    expect((await h.service.resolve('abc1234', NOW)).kind).toBe('not_found');
    expect(h.logs.map((l) => l.event)).toEqual(['URL_NOT_FOUND']);
  });

  it.each(['favicon.ico', 'robots.txt', 'health', 'METRICS', 'abc', 'a'.repeat(13), 'abc-123'])(
    'reports not_found for %p without querying the database',
    async (code) => {
      const h = harness(active);
      expect((await h.service.resolve(code, NOW)).kind).toBe('not_found');
      expect(h.findUnique).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['redirect', active, 'URL_REDIRECTED'],
    ['expired', { ...active, expiresAt: new Date(0) }, 'URL_EXPIRED'],
    ['deleted', { ...active, deletedAt: new Date(0) }, 'URL_DELETED_ACCESSED'],
  ])('logs %s with its event and never the destination', async (_kind, record, event) => {
    const h = harness(record);
    await h.service.resolve('abc1234', NOW);
    expect(h.logs.map((l) => l.event)).toEqual([event]);
    expect(JSON.stringify(h.logs)).not.toContain('example.com');
  });
});
