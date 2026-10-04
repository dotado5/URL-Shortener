import { Job, UnrecoverableError, Worker } from 'bullmq';

// Only Worker is replaced (it would open a Redis connection); every other export stays real,
// including UnrecoverableError, whose identity the processor relies on.
jest.mock('bullmq', () => ({
  ...jest.requireActual<object>('bullmq'),
  Worker: jest.fn(() => ({ on: jest.fn(), close: jest.fn() })),
}));
const MockWorker = Worker as unknown as jest.Mock;
import type { PinoLogger } from 'nestjs-pino';
import { MetricsService } from '../../metrics/metrics.service';
import { CLEANUP_JOB_NAME, CleanupProcessor } from './cleanup.processor';
import type { CleanupReport, CleanupService } from './cleanup.service';

const REPORT: CleanupReport = {
  expiredDeactivated: 12,
  clickEventsDeleted: 340,
  batches: 3,
  complete: true,
  durationMs: 42,
};

/** Builds a processor without its constructor, which would open Redis connections. */
function processorWith(
  run: CleanupService['run'],
  opts: { jobTimeoutMs?: number; upsert?: jest.Mock } = {},
) {
  const p = Object.create(CleanupProcessor.prototype) as CleanupProcessor;
  const metrics = new MetricsService();
  const logs: Record<string, unknown>[] = [];
  const push = (o: Record<string, unknown>) => logs.push(o);
  Object.assign(p, {
    cleanup: { run },
    metrics,
    logger: { info: push, warn: push } as unknown as PinoLogger,
    queueName: 'url-cleanup',
    cron: '*/15 * * * *',
    jobTimeoutMs: opts.jobTimeoutMs ?? 10_000,
    queue: { upsertJobScheduler: opts.upsert ?? jest.fn().mockResolvedValue({}) },
    stopping: true, // never arm the background retry timer in tests
  });
  return { p, metrics, logs };
}

const job = (name = CLEANUP_JOB_NAME) => ({ id: '7', name }) as Job;

describe('CleanupProcessor.process', () => {
  it('runs the sweep with 80% of JOB_TIMEOUT_MS as its budget', async () => {
    const run = jest.fn().mockResolvedValue(REPORT);
    const now = new Date('2026-09-30T00:00:00.000Z');
    const { p } = processorWith(run, { jobTimeoutMs: 10_000 });
    await expect(p.process(job(), now)).resolves.toEqual(REPORT);
    expect(run).toHaveBeenCalledWith(now, 8_000);
  });

  it('records row counts as metrics and logs CLEANUP_COMPLETED with the report', async () => {
    const { p, metrics, logs } = processorWith(jest.fn().mockResolvedValue(REPORT));
    await p.process(job());
    const values = (await metrics.cleanupRows.get()).values;
    const by = (action: string) => values.find((v) => v.labels.action === action)?.value;
    expect(by('expired_deactivated')).toBe(12);
    expect(by('click_events_deleted')).toBe(340);
    expect(logs).toEqual([expect.objectContaining({ event: 'CLEANUP_COMPLETED', ...REPORT })]);
  });

  it('fails permanently for an unexpected job name', async () => {
    const run = jest.fn();
    const { p } = processorWith(run);
    await expect(p.process(job('something-else'))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(run).not.toHaveBeenCalled();
  });

  it('lets database errors through so BullMQ retries', async () => {
    const { p } = processorWith(jest.fn().mockRejectedValue(new Error('deadlock detected')));
    const err = await p.process(job()).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });
});

describe('CleanupProcessor.ensureScheduler', () => {
  it('upserts one scheduler under a fixed id, in UTC, with retries on the job template', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const { p, logs } = processorWith(jest.fn(), { upsert });
    await expect(p.ensureScheduler()).resolves.toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      'url-cleanup-schedule',
      { pattern: '*/15 * * * *', tz: 'UTC' },
      expect.objectContaining({
        name: 'cleanup',
        opts: expect.objectContaining({ attempts: 3 }),
      }),
    );
    expect(logs[0]).toMatchObject({ event: 'CLEANUP_SCHEDULED' });
  });

  it('does not throw when Redis is down; logs and reports failure', async () => {
    const { p, logs } = processorWith(jest.fn(), {
      upsert: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    });
    await expect(p.ensureScheduler()).resolves.toBe(false);
    expect(logs[0]).toMatchObject({ event: 'CLEANUP_SCHEDULE_FAILED' });
  });

  it('gives up on an attempt that hangs, as BullMQ does while waiting for Redis (regression)', async () => {
    const { p, logs } = processorWith(jest.fn(), {
      upsert: jest.fn(() => new Promise(() => undefined)),
    });
    Object.assign(p, { schedulerAttemptTimeoutMs: 20 });
    const t0 = Date.now();
    await expect(p.ensureScheduler()).resolves.toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(logs[0]).toMatchObject({ event: 'CLEANUP_SCHEDULE_FAILED' });
  });
});

describe('CleanupProcessor.onModuleInit', () => {
  it('returns without waiting for schedule registration, so boot never blocks on Redis', () => {
    const upsert = jest.fn(() => new Promise(() => undefined));
    const { p } = processorWith(jest.fn(), { upsert });
    Object.assign(p, { schedulerAttemptTimeoutMs: 20, redisUrl: 'redis://127.0.0.1:1' });

    const result = p.onModuleInit();

    expect(result).toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(MockWorker).toHaveBeenCalledWith(
      'url-cleanup',
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
  });
});
