import { HealthService } from './health.service';
import type { PrismaService } from '../prisma/prisma.service';

function makeService(pingOk: boolean): HealthService {
  const prisma = {
    ping: () => (pingOk ? Promise.resolve() : Promise.reject(new Error('down'))),
  } as unknown as PrismaService;
  return new HealthService(prisma);
}

describe('HealthService.readiness', () => {
  it('is ok when the database is up', async () => {
    await expect(makeService(true).readiness()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up' },
    });
  });

  it('is down when the database is down', async () => {
    await expect(makeService(false).readiness()).resolves.toEqual({
      status: 'down',
      checks: { database: 'down' },
    });
  });

  it('is degraded, not down, when a non-critical dependency fails', async () => {
    const svc = makeService(true);
    svc.register({ name: 'redis', critical: false, check: () => Promise.resolve(false) });
    await expect(svc.readiness()).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'up', redis: 'degraded' },
    });
  });

  it('a critical failure wins over a degraded one', async () => {
    const svc = makeService(false);
    svc.register({ name: 'redis', critical: false, check: () => Promise.resolve(false) });
    const report = await svc.readiness();
    expect(report.status).toBe('down');
  });

  it('reports down once shutdown has started even if dependencies are healthy', async () => {
    const svc = makeService(true);
    svc.markShuttingDown();
    const report = await svc.readiness();
    expect(report.status).toBe('down');
    expect(report.checks.database).toBe('up');
  });
});
