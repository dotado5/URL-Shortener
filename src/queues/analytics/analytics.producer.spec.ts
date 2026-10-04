import type { PinoLogger } from 'nestjs-pino';
import { hashIp } from '../../common/utils/ip';
import { MetricsService } from '../../metrics/metrics.service';
import { DEFAULT_JOB_OPTIONS } from '../queue-options';
import { AnalyticsProducer } from './analytics.producer';
import { clickEventSchema } from './click-event';

const SECRET = 's'.repeat(32);

/** Builds a producer without its constructor, which would open a Redis connection. */
function producerWith(add: jest.Mock, timeoutMs = 200) {
  const p = Object.create(AnalyticsProducer.prototype) as AnalyticsProducer;
  const metrics = new MetricsService();
  const logs: Record<string, unknown>[] = [];
  Object.assign(p, {
    queue: { add },
    queueName: 'url-analytics',
    secret: SECRET,
    timeoutMs,
    metrics,
    logger: {
      debug: jest.fn(),
      warn: (o: Record<string, unknown>) => logs.push(o),
    } as unknown as PinoLogger,
  });
  const created = async (result: string) =>
    (await metrics.jobsCreated.get()).values.find((v) => v.labels.result === result)?.value ?? 0;
  return { p, logs, created };
}

const ctx = {
  shortCode: 'abc1234',
  ip: '203.0.113.9',
  userAgent: 'Mozilla/5.0',
  referer: 'https://news.example/',
};

describe('AnalyticsProducer.buildEvent', () => {
  it('builds a payload the worker will accept', () => {
    const { p } = producerWith(jest.fn());
    const event = p.buildEvent(ctx, new Date('2026-09-29T12:00:00.000Z'));
    expect(clickEventSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      shortCode: 'abc1234',
      timestamp: '2026-09-29T12:00:00.000Z',
      userAgent: 'Mozilla/5.0',
      referer: 'https://news.example/',
    });
  });

  it('hashes the IP with the secret and never includes it raw', () => {
    const { p } = producerWith(jest.fn());
    const event = p.buildEvent(ctx);
    expect(event.ipHash).toBe(hashIp('203.0.113.9', SECRET));
    expect(JSON.stringify(event)).not.toContain('203.0.113.9');
  });

  it('gives every click its own eventId', () => {
    const { p } = producerWith(jest.fn());
    expect(p.buildEvent(ctx).eventId).not.toBe(p.buildEvent(ctx).eventId);
  });

  it('truncates long headers to the column size and maps missing ones to null', () => {
    const { p } = producerWith(jest.fn());
    const event = p.buildEvent({ ...ctx, userAgent: 'x'.repeat(2000), referer: undefined });
    expect(event.userAgent).toHaveLength(512);
    expect(event.referer).toBeNull();
  });
});

describe('AnalyticsProducer.enqueue', () => {
  it('adds the job with eventId as the jobId so BullMQ deduplicates re-adds', async () => {
    const add = jest.fn().mockResolvedValue({});
    const { p, created } = producerWith(add);
    const event = p.buildEvent(ctx);
    await expect(p.enqueue(event)).resolves.toBe(true);
    expect(add).toHaveBeenCalledWith('click', event, { jobId: event.eventId });
    expect(await created('ok')).toBe(1);
  });

  it('never rejects when Redis fails; counts and logs the dropped click', async () => {
    const { p, logs, created } = producerWith(jest.fn().mockRejectedValue(new Error('down')));
    await expect(p.enqueue(p.buildEvent(ctx))).resolves.toBe(false);
    expect(await created('error')).toBe(1);
    expect(logs[0]).toMatchObject({ event: 'ANALYTICS_ENQUEUE_FAILED', shortCode: 'abc1234' });
  });

  it('gives up after the enqueue timeout instead of holding the promise forever', async () => {
    const { p } = producerWith(
      jest.fn(() => new Promise(() => undefined)),
      20,
    );
    const t0 = Date.now();
    await expect(p.enqueue(p.buildEvent(ctx))).resolves.toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('record() returns synchronously even while the enqueue is pending', () => {
    const { p } = producerWith(
      jest.fn(() => new Promise(() => undefined)),
      20,
    );
    expect(p.record(ctx)).toBeUndefined();
  });

  it('never logs the IP, user agent or referer', async () => {
    const { p, logs } = producerWith(jest.fn().mockRejectedValue(new Error('down')));
    await p.enqueue(p.buildEvent(ctx));
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('203.0.113.9');
    expect(logged).not.toContain('Mozilla');
    expect(logged).not.toContain('news.example');
  });
});

describe('DEFAULT_JOB_OPTIONS', () => {
  it('retries 3 times with exponential backoff and keeps failures for a week', () => {
    expect(DEFAULT_JOB_OPTIONS).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnFail: { age: 604_800 },
    });
  });
});
