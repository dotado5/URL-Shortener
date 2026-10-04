import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { bootIsolated } from './isolated';

type Helpers = typeof import('./helpers.js');
type Bootstrap = typeof import('../src/bootstrap.js');
type WorkerModuleFile = typeof import('../src/worker.module.js');
type PrismaFile = typeof import('../src/prisma/prisma.service.js');
type ProducerFile = typeof import('../src/queues/analytics/analytics.producer.js');
type RecorderFile = typeof import('../src/queues/analytics/click-recorder.js');
type IpFile = typeof import('../src/common/utils/ip.js');

const SECRET = 'analytics-e2e-secret-analytics-e2e-00';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  probe: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (done(v)) return v;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting; last value ${JSON.stringify(v)}`);
    await sleep(50);
  }
}

describe('Async click analytics (e2e)', () => {
  let api: NestExpressApplication;
  let worker: NestExpressApplication;
  let helpers: Helpers;
  let prisma: InstanceType<PrismaFile['PrismaService']>;
  let queue: Queue;
  let recorder: InstanceType<RecorderFile['ClickRecorder']>;
  let hashIp: IpFile['hashIp'];
  let workerClosed = false;

  beforeAll(async () => {
    ({ api, worker, helpers, prisma, queue, recorder, hashIp } = await bootIsolated(
      {
        // A private queue so jobs left over by other suites never reach this worker.
        BULLMQ_ANALYTICS_QUEUE: `e2e-analytics-${randomUUID()}`,
        IP_HASH_SECRET: SECRET,
        JOB_TIMEOUT_MS: '5000',
      },
      async (load) => {
        const helpers = load<Helpers>('./helpers');
        const { createApp } = load<Bootstrap>('../src/bootstrap');
        const { WorkerModule } = load<WorkerModuleFile>('../src/worker.module');
        const { PrismaService } = load<PrismaFile>('../src/prisma/prisma.service');
        const { AnalyticsProducer } = load<ProducerFile>(
          '../src/queues/analytics/analytics.producer',
        );
        const { ClickRecorder } = load<RecorderFile>('../src/queues/analytics/click-recorder');
        const { hashIp } = load<IpFile>('../src/common/utils/ip');

        const api = await helpers.createTestApp();
        const worker = await createApp(WorkerModule);
        await worker.listen(0, '127.0.0.1');
        await helpers.resetDatabase(api);
        return {
          api,
          worker,
          helpers,
          prisma: api.get(PrismaService),
          queue: api.get(AnalyticsProducer).queue,
          recorder: worker.get(ClickRecorder),
          hashIp,
        };
      },
    ));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await api.close();
    if (!workerClosed) await worker.close();
  });

  const http = () => request(api.getHttpServer());

  async function create(url = 'https://example.com/tracked') {
    const res = await http()
      .post('/api/urls')
      .set('Content-Type', 'application/json')
      .send({ url })
      .expect(201);
    return res.body as { shortCode: string; deleteToken: string };
  }

  const clickCount = async (shortCode: string) =>
    (await prisma.url.findUniqueOrThrow({ where: { shortCode } })).clickCount;

  const workerMetric = async (name: string, labels: Record<string, string>) => {
    const text = (await request(worker.getHttpServer()).get('/metrics')).text;
    const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
    const line = text
      .split('\n')
      .find((l) => l.startsWith(`${name}{`) && want.every((w) => l.includes(w)));
    return line ? Number(line.split(' ')[1]) : 0;
  };

  it('a redirect is counted asynchronously with a hashed IP, user agent and referer', async () => {
    const { shortCode } = await create();
    const url = await prisma.url.findUniqueOrThrow({ where: { shortCode } });

    const t0 = Date.now();
    await http()
      .get(`/${shortCode}`)
      .set('User-Agent', 'e2e-agent/1.0')
      .set('Referer', 'https://news.example/story')
      .redirects(0)
      .expect(302);
    // The redirect does not wait for the worker.
    expect(Date.now() - t0).toBeLessThan(500);

    await waitFor(
      () => clickCount(shortCode),
      (n) => n === 1,
    );

    const events = await prisma.clickEvent.findMany({ where: { urlId: url.id } });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.userAgent).toBe('e2e-agent/1.0');
    expect(e.referer).toBe('https://news.example/story');
    expect(e.ipHash).toBe(hashIp('127.0.0.1', SECRET));
    expect(e.ipHash).not.toContain('127');
    expect(e.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('counts every click under a burst of concurrent redirects', async () => {
    const { shortCode } = await create();
    await Promise.all(
      Array.from({ length: 25 }, () => http().get(`/${shortCode}`).redirects(0).expect(302)),
    );
    await waitFor(
      () => clickCount(shortCode),
      (n) => n === 25,
    );
  });

  it('does not count HEAD, 404 or 410 responses', async () => {
    const { shortCode, deleteToken } = await create();
    const created0 = await helpers.metricValue(api, 'jobs_created_total', { result: 'ok' });

    await http().head(`/${shortCode}`).redirects(0).expect(302);
    await http().get('/zzzzzzz').expect(404);
    await http().delete(`/api/urls/${shortCode}`).set('X-Delete-Token', deleteToken).expect(204);
    await http().get(`/${shortCode}`).redirects(0).expect(410);

    await sleep(500);
    expect(await helpers.metricValue(api, 'jobs_created_total', { result: 'ok' })).toBe(created0);
    expect(await clickCount(shortCode)).toBe(0);
  });

  it('replaying an already-recorded event changes nothing (exactly-once effect)', async () => {
    const { shortCode } = await create();
    await http().get(`/${shortCode}`).redirects(0).expect(302);
    await waitFor(
      () => clickCount(shortCode),
      (n) => n === 1,
    );
    const [event] = await prisma.clickEvent.findMany({
      where: { url: { shortCode } },
    });

    const duplicates0 = await workerMetric('jobs_total', { result: 'duplicate' });
    // A different jobId defeats BullMQ's own dedup, forcing the database to be the guard.
    const replay = await queue.add('click', {
      eventId: event.eventId,
      shortCode,
      timestamp: event.createdAt.toISOString(),
      userAgent: event.userAgent,
      referer: event.referer,
      ipHash: event.ipHash,
    });
    await waitFor(
      () => replay.getState(),
      (s) => s === 'completed',
    );

    expect(await clickCount(shortCode)).toBe(1);
    expect(await prisma.clickEvent.count({ where: { eventId: event.eventId } })).toBe(1);
    expect(await workerMetric('jobs_total', { result: 'duplicate' })).toBe(duplicates0 + 1);
  });

  it('adding the same jobId twice is ignored by BullMQ itself', async () => {
    const { shortCode } = await create();
    const data = {
      eventId: randomUUID(),
      shortCode,
      timestamp: new Date().toISOString(),
      userAgent: null,
      referer: null,
      ipHash: 'b'.repeat(64),
    };
    await queue.add('click', data, { jobId: data.eventId });
    await queue.add('click', data, { jobId: data.eventId });
    await waitFor(
      () => clickCount(shortCode),
      (n) => n === 1,
    );
    await sleep(300);
    expect(await clickCount(shortCode)).toBe(1);
  });

  describe('failure handling', () => {
    it('an unknown short code fails permanently on the first attempt', async () => {
      const job = await queue.add('click', {
        eventId: randomUUID(),
        shortCode: 'Nope123',
        timestamp: new Date().toISOString(),
        userAgent: null,
        referer: null,
        ipHash: 'c'.repeat(64),
      });
      await waitFor(
        () => job.getState(),
        (s) => s === 'failed',
      );
      const failed = await queue.getJob(job.id!);
      expect(failed!.attemptsMade).toBe(1);
      expect(failed!.failedReason).toMatch(/does not exist/);
    });

    it('a malformed payload fails permanently without retries', async () => {
      const job = await queue.add('click', { eventId: 'not-a-uuid', shortCode: 'abc1234' });
      await waitFor(
        () => job.getState(),
        (s) => s === 'failed',
      );
      expect((await queue.getJob(job.id!))!.attemptsMade).toBe(1);
    });

    it('a transient failure is retried with backoff and then succeeds', async () => {
      const { shortCode } = await create();
      const spy = jest
        .spyOn(recorder, 'record')
        .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

      await http().get(`/${shortCode}`).redirects(0).expect(302);
      await waitFor(
        () => clickCount(shortCode),
        (n) => n === 1,
        15_000,
      );

      expect(spy).toHaveBeenCalledTimes(2);
      const [job] = await queue.getJobs(['completed'], 0, 0, false);
      expect(job.attemptsMade).toBeGreaterThanOrEqual(1);
    });

    it('failed jobs are retained for inspection', async () => {
      expect(await queue.getJobCountByTypes('failed')).toBeGreaterThanOrEqual(2);
    });
  });

  describe('worker process', () => {
    it('is ready only with both PostgreSQL and Redis, both critical', async () => {
      const res = await request(worker.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    });

    it('exposes queue depth and job metrics', async () => {
      const text = (await request(worker.getHttpServer()).get('/metrics')).text;
      expect(text).toMatch(/^queue_depth\{queue="e2e-analytics-[^"]+",state="failed"\} \d+/m);
      expect(text).toMatch(/^jobs_total\{queue="[^"]+",result="completed"\} \d+/m);
      expect(text).toContain('job_duration_seconds_bucket');
    });

    it('graceful shutdown lets an in-flight job finish before closing', async () => {
      const { shortCode } = await create();
      const real = recorder.record.bind(recorder);
      let started!: () => void;
      const jobStarted = new Promise<void>((r) => (started = r));
      jest.spyOn(recorder, 'record').mockImplementation(async (event) => {
        started();
        await sleep(1_500);
        return real(event);
      });

      await http().get(`/${shortCode}`).redirects(0).expect(302);
      await jobStarted;

      const t0 = Date.now();
      await worker.close();
      workerClosed = true;

      // close() waited for the job rather than abandoning it.
      expect(Date.now() - t0).toBeGreaterThan(1_000);
      expect(await clickCount(shortCode)).toBe(1);
    });
  });
});
