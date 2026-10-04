import { randomUUID } from 'node:crypto';
import { AddressInfo, createServer } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Queue } from 'bullmq';
import request from 'supertest';
import { bootIsolated } from './isolated';

type Helpers = typeof import('./helpers.js');
type Bootstrap = typeof import('../src/bootstrap.js');
type WorkerModuleFile = typeof import('../src/worker.module.js');
type PrismaFile = typeof import('../src/prisma/prisma.service.js');
type CleanupFile = typeof import('../src/queues/cleanup/cleanup.service.js');

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Cleanup job (e2e)', () => {
  const cleanupQueueName = `e2e-cleanup-${randomUUID()}`;
  const env = {
    BULLMQ_CLEANUP_QUEUE: cleanupQueueName,
    BULLMQ_ANALYTICS_QUEUE: `e2e-analytics-${randomUUID()}`,
    CLEANUP_BATCH_SIZE: String(BATCH),
    ANALYTICS_RETENTION_DAYS: '30',
  };

  let worker: NestExpressApplication;
  let prisma: InstanceType<PrismaFile['PrismaService']>;
  let cleanup: InstanceType<CleanupFile['CleanupService']>;
  let queue: Queue;

  async function bootWorker() {
    return bootIsolated(env, async (load) => {
      const { createApp } = load<Bootstrap>('../src/bootstrap');
      const { WorkerModule } = load<WorkerModuleFile>('../src/worker.module');
      const { PrismaService } = load<PrismaFile>('../src/prisma/prisma.service');
      const { CleanupService } = load<CleanupFile>('../src/queues/cleanup/cleanup.service');
      const helpers = load<Helpers>('./helpers');
      const app = await createApp(WorkerModule);
      await app.listen(0, '127.0.0.1');
      return {
        app,
        helpers,
        prisma: app.get(PrismaService),
        cleanup: app.get(CleanupService),
      };
    });
  }

  beforeAll(async () => {
    ({ app: worker, prisma, cleanup } = await bootWorker());
    queue = new Queue(cleanupQueueName, { connection: { url: process.env.REDIS_URL! } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ClickEvent", "Url" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await worker.close();
  });

  let seq = 0;
  async function seed(
    rows: { expiresAt?: Date | null; isActive?: boolean; deletedAt?: Date | null }[],
  ): Promise<string[]> {
    const codes = rows.map(() => `Cln${String(seq++).padStart(4, '0')}`);
    await prisma.url.createMany({
      data: rows.map((r, i) => ({
        shortCode: codes[i],
        originalUrl: `https://example.com/${codes[i]}`,
        deleteTokenHash: '0'.repeat(64),
        expiresAt: r.expiresAt ?? null,
        isActive: r.isActive ?? true,
        deletedAt: r.deletedAt ?? null,
      })),
    });
    return codes;
  }

  const expired = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ expiresAt: new Date(Date.now() - (i + 1) * 60_000) }));

  const activeFlags = async (codes: string[]) =>
    (
      await prisma.url.findMany({
        where: { shortCode: { in: codes } },
        orderBy: { shortCode: 'asc' },
        select: { isActive: true },
      })
    ).map((r) => r.isActive);

  describe('expired-URL sweep', () => {
    it('deactivates only expired, still-active rows, in batches', async () => {
      const exp = await seed(expired(7));
      const deletedAndExpired = await seed([
        { expiresAt: new Date(Date.now() - DAY), deletedAt: new Date() },
      ]);
      const untouched = await seed([
        { expiresAt: null },
        { expiresAt: null },
        { expiresAt: new Date(Date.now() + DAY) },
        { expiresAt: new Date(Date.now() + 60_000) },
      ]);
      const alreadyInactive = await seed([
        { expiresAt: new Date(Date.now() - DAY), isActive: false },
      ]);

      const report = await cleanup.run(new Date(), 60_000);

      expect(report.expiredDeactivated).toBe(8);
      expect(report.complete).toBe(true);
      // 8 rows at 3 per batch: 3 + 3 + 2, then one empty retention batch.
      expect(report.batches).toBe(4);
      expect(await activeFlags(exp)).toEqual(Array(7).fill(false));
      expect(await activeFlags(deletedAndExpired)).toEqual([false]);
      expect(await activeFlags(untouched)).toEqual([true, true, true, true]);
      expect(await activeFlags(alreadyInactive)).toEqual([false]);
    });

    it('is idempotent: a second run changes nothing', async () => {
      await seed(expired(5));
      expect((await cleanup.run(new Date(), 60_000)).expiredDeactivated).toBe(5);
      const again = await cleanup.run(new Date(), 60_000);
      expect(again).toMatchObject({ expiredDeactivated: 0, clickEventsDeleted: 0, complete: true });
    });

    it('bumps updatedAt on the rows it changes', async () => {
      const [code] = await seed(expired(1));
      const before = (await prisma.url.findUniqueOrThrow({ where: { shortCode: code } })).updatedAt;
      await sleep(10);
      await cleanup.run(new Date(), 60_000);
      const after = (await prisma.url.findUniqueOrThrow({ where: { shortCode: code } })).updatedAt;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });

    it('stops when the time budget is spent and the next run finishes the backlog', async () => {
      const codes = await seed(expired(7));
      const first = await cleanup.run(new Date(), 0);
      expect(first).toMatchObject({ expiredDeactivated: BATCH, batches: 1, complete: false });

      const second = await cleanup.run(new Date(), 60_000);
      expect(second.expiredDeactivated).toBe(4);
      expect(second.complete).toBe(true);
      expect(await activeFlags(codes)).toEqual(Array(7).fill(false));
    });

    it('two concurrent runs split the work without touching a row twice', async () => {
      const codes = await seed(expired(12));
      const [a, b] = await Promise.all([
        cleanup.run(new Date(), 60_000),
        cleanup.run(new Date(), 60_000),
      ]);
      expect(a.expiredDeactivated + b.expiredDeactivated).toBe(12);
      expect(await activeFlags(codes)).toEqual(Array(12).fill(false));
    });

    it('does not change what the redirect returns: expiry is enforced at read time', async () => {
      const [code] = await seed(expired(1));
      // Before the sweep, isActive is still true, and the URL is already treated as expired.
      const info = await bootIsolated(env, async (load) => {
        const helpers = load<Helpers>('./helpers');
        const api = await helpers.createTestApp();
        const before = await request(api.getHttpServer()).get(`/${code}`).redirects(0);
        await cleanup.run(new Date(), 60_000);
        const after = await request(api.getHttpServer()).get(`/${code}`).redirects(0);
        await api.close();
        return { before: before.status, after: after.status };
      });
      expect(info).toEqual({ before: 410, after: 410 });
    });
  });

  describe('click-event retention (30 days)', () => {
    it('deletes events past retention, keeps recent ones, and leaves clickCount alone', async () => {
      const [code] = await seed([{ expiresAt: null }]);
      const url = await prisma.url.update({
        where: { shortCode: code },
        data: { clickCount: 9 },
      });
      const event = (daysAgo: number) => ({
        eventId: randomUUID(),
        urlId: url.id,
        createdAt: new Date(Date.now() - daysAgo * DAY),
        ipHash: 'a'.repeat(64),
      });
      await prisma.clickEvent.createMany({
        data: [...[31, 45, 60, 90, 400].map(event), ...[0, 1, 29, 29.9].map(event)],
      });

      const report = await cleanup.run(new Date(), 60_000);

      expect(report.clickEventsDeleted).toBe(5);
      expect(await prisma.clickEvent.count()).toBe(4);
      const oldest = await prisma.clickEvent.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
      expect(Date.now() - oldest.createdAt.getTime()).toBeLessThan(30 * DAY);
      // The lifetime total survives pruning of the per-click detail.
      expect((await prisma.url.findUniqueOrThrow({ where: { shortCode: code } })).clickCount).toBe(
        9,
      );
    });
  });

  describe('scheduling', () => {
    it('registers exactly one schedule, in UTC, on the configured cron', async () => {
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]).toMatchObject({
        key: 'url-cleanup-schedule',
        pattern: '*/15 * * * *',
        tz: 'UTC',
      });
      expect(schedulers[0].next).toBeGreaterThan(Date.now());
    });

    it('a second worker replica does not add a second schedule', async () => {
      const second = await bootWorker();
      try {
        expect(await queue.getJobSchedulersCount()).toBe(1);
      } finally {
        await second.app.close();
      }
    });

    it('a cleanup job on the queue is processed by the worker end to end', async () => {
      const codes = await seed(expired(4));
      const job = await queue.add('cleanup', {});
      const deadline = Date.now() + 10_000;
      while ((await job.getState()) !== 'completed') {
        if (Date.now() > deadline) throw new Error(`job stuck in ${await job.getState()}`);
        await sleep(50);
      }
      const done = await Queue.prototype.getJob.call(queue, job.id!);
      expect(done!.returnvalue).toMatchObject({ expiredDeactivated: 4, complete: true });
      expect(await activeFlags(codes)).toEqual(Array(4).fill(false));
    });

    it('rejects unknown job names permanently', async () => {
      const job = await queue.add('mystery', {});
      const deadline = Date.now() + 10_000;
      while ((await job.getState()) !== 'failed') {
        if (Date.now() > deadline) throw new Error('job did not fail');
        await sleep(50);
      }
      expect((await queue.getJob(job.id!))!.attemptsMade).toBe(1);
    });
  });

  describe('worker metrics', () => {
    it('exposes cleanup counters and queue depth for both queues', async () => {
      await seed(expired(2));
      await cleanup.run(new Date(), 60_000);
      await queue.add('cleanup', {});
      await sleep(500);
      const text = (await request(worker.getHttpServer()).get('/metrics')).text;
      expect(text).toMatch(/^cleanup_rows_total\{action="expired_deactivated"\} \d+/m);
      expect(text).toContain(`queue_depth{queue="${cleanupQueueName}"`);
      expect(text).toMatch(/queue_depth\{queue="e2e-analytics-/);
    });
  });
});

describe('Worker boot with Redis unavailable (e2e)', () => {
  it('starts serving health immediately: live 200, ready 503, instead of hanging (regression)', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));

    const t0 = Date.now();
    const worker = await bootIsolated(
      {
        REDIS_URL: `redis://127.0.0.1:${port}`,
        BULLMQ_CLEANUP_QUEUE: `e2e-cleanup-${randomUUID()}`,
        BULLMQ_ANALYTICS_QUEUE: `e2e-analytics-${randomUUID()}`,
      },
      async (load) => {
        const { createApp } = load<Bootstrap>('../src/bootstrap');
        const { WorkerModule } = load<WorkerModuleFile>('../src/worker.module');
        const app = await createApp(WorkerModule);
        await app.listen(0, '127.0.0.1');
        return app;
      },
    );
    try {
      expect(Date.now() - t0).toBeLessThan(10_000);
      await request(worker.getHttpServer()).get('/health/live').expect(200);
      const ready = await request(worker.getHttpServer()).get('/health/ready').expect(503);
      expect(ready.body).toEqual({ status: 'down', checks: { database: 'up', redis: 'down' } });
    } finally {
      await worker.close();
    }
  });
});
