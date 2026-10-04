import { randomUUID } from 'node:crypto';
import { Job, UnrecoverableError } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { MetricsService } from '../../metrics/metrics.service';
import { AnalyticsProcessor, withTimeout } from './analytics.processor';
import type { ClickEvent } from './click-event';
import type { ClickRecorder } from './click-recorder';

/** Builds a processor without its constructor, which would open Redis connections. */
function processorWith(record: ClickRecorder['record'], jobTimeoutMs = 1_000) {
  const p = Object.create(AnalyticsProcessor.prototype) as AnalyticsProcessor;
  Object.assign(p, {
    recorder: { record },
    metrics: new MetricsService(),
    logger: { debug: jest.fn() } as unknown as PinoLogger,
    queueName: 'test',
    jobTimeoutMs,
  });
  return p;
}

const valid: ClickEvent = {
  eventId: randomUUID(),
  shortCode: 'abc1234',
  timestamp: '2026-09-29T12:00:00.000Z',
  userAgent: 'curl/8',
  referer: null,
  ipHash: 'a'.repeat(64),
};

const job = (data: unknown) => ({ id: '1', data }) as Job;

describe('AnalyticsProcessor.process', () => {
  it('records a valid click', async () => {
    const record = jest.fn().mockResolvedValue('recorded');
    await expect(processorWith(record).process(job(valid))).resolves.toBe('recorded');
    expect(record).toHaveBeenCalledWith(valid);
  });

  it('treats a replayed event as a successful no-op', async () => {
    const p = processorWith(jest.fn().mockResolvedValue('duplicate'));
    await expect(p.process(job(valid))).resolves.toBe('duplicate');
  });

  it.each([
    ['not an object', 'x'],
    ['missing eventId', { ...valid, eventId: undefined }],
    ['non-uuid eventId', { ...valid, eventId: '123' }],
    ['malformed shortCode', { ...valid, shortCode: 'bad-code!' }],
    ['raw IP instead of a hash', { ...valid, ipHash: '203.0.113.9' }],
    ['oversized user agent', { ...valid, userAgent: 'x'.repeat(513) }],
    ['timestamp without zone', { ...valid, timestamp: '2026-09-29T12:00:00' }],
  ])('fails permanently, without touching the database, for %s', async (_name, data) => {
    const record = jest.fn();
    await expect(processorWith(record).process(job(data))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('fails permanently when the short code does not exist', async () => {
    const p = processorWith(jest.fn().mockResolvedValue('url_missing'));
    await expect(p.process(job(valid))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('lets database errors through as ordinary errors so BullMQ retries them', async () => {
    const p = processorWith(jest.fn().mockRejectedValue(new Error('connection refused')));
    const err = await p.process(job(valid)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it('turns a hung write into a retryable timeout', async () => {
    const p = processorWith(() => new Promise(() => undefined), 20);
    const err = await p.process(job(valid)).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/exceeded 20ms/);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });
});

describe('withTimeout', () => {
  it('passes through a result that arrives in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 100)).resolves.toBe(7);
  });

  it('rejects once the deadline passes', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toThrow(/exceeded 10ms/);
  });
});
