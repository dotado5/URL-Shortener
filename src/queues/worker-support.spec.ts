import type { Worker } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { InFlight, closeWorker, settlesWithin } from './worker-support';

function logger() {
  const logs: Record<string, unknown>[] = [];
  const push = (o: Record<string, unknown>) => logs.push(o);
  return { logs, logger: { info: push, warn: push } as unknown as PinoLogger };
}

const never = () => new Promise<void>(() => undefined);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('settlesWithin', () => {
  it('is true for a promise that resolves or rejects in time', async () => {
    expect(await settlesWithin(Promise.resolve(), 50)).toBe(true);
    expect(await settlesWithin(Promise.reject(new Error('x')), 50)).toBe(true);
  });

  it('is false for a promise that never settles', async () => {
    expect(await settlesWithin(never(), 20)).toBe(false);
  });
});

describe('InFlight', () => {
  it('counts work while it runs, including work that throws', async () => {
    const f = new InFlight();
    let seen = -1;
    await f.track(async () => {
      seen = f.count;
      await sleep(1);
    });
    expect(seen).toBe(1);
    await f.track(() => Promise.reject(new Error('boom'))).catch(() => undefined);
    expect(f.count).toBe(0);
  });
});

describe('closeWorker', () => {
  const opts = (inFlight = new InFlight(), jobTimeoutMs = 10_000) => {
    const { logger: l, logs } = logger();
    return { o: { inFlight, jobTimeoutMs, queueName: 'q', logger: l }, logs };
  };

  it('force-closes an idle worker straight away: nothing to drain', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const { o, logs } = opts();
    await closeWorker({ close } as unknown as Worker, o);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(true);
    expect(logs).toEqual([expect.objectContaining({ event: 'WORKER_STOPPING', activeJobs: 0 })]);
  });

  it('never hangs on an idle worker whose close does not settle (regression)', async () => {
    const close = jest.fn(() => never());
    const { o } = opts();
    const t0 = Date.now();
    await closeWorker({ close } as unknown as Worker, o);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('drains a busy worker gracefully within the job grace', async () => {
    const inFlight = new InFlight();
    let release!: () => void;
    const job = inFlight.track(() => new Promise<void>((r) => (release = r)));
    const close = jest.fn(() => job);
    const disconnect = jest.fn();
    setTimeout(() => release(), 2_300);
    const { o, logs } = opts(inFlight, 5_000);

    await closeWorker({ close, disconnect } as unknown as Worker, o);

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith();
    expect(disconnect).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ event: 'WORKER_STOPPING', activeJobs: 1, graceMs: 6_000 });
  });

  it('hard-disconnects a busy worker that outlives its grace, instead of re-calling close', async () => {
    const inFlight = new InFlight();
    void inFlight.track(() => never());
    const close = jest.fn(() => never());
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const { o, logs } = opts(inFlight, 50);

    await closeWorker({ close, disconnect } as unknown as Worker, o);

    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(logs.map((x) => x.event)).toEqual(['WORKER_STOPPING', 'WORKER_FORCE_CLOSED']);
  });
});
