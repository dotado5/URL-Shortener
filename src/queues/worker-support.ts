import { Injectable } from '@nestjs/common';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { Gauge } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';

/**
 * One `queue_depth{queue,state}` gauge for every queue the worker consumes. prom-client refuses
 * two metrics with the same name in a registry, so processors register their queue here instead
 * of creating their own gauge.
 */
@Injectable()
export class QueueDepthMetrics {
  private readonly queues = new Map<string, Queue>();

  constructor(metrics: MetricsService) {
    const queues = this.queues;
    new Gauge({
      name: 'queue_depth',
      help: 'Jobs in the queue by state',
      labelNames: ['queue', 'state'] as const,
      registers: [metrics.registry],
      async collect() {
        await Promise.all(
          [...queues].map(async ([name, q]) => {
            try {
              const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
              for (const [state, n] of Object.entries(counts)) this.set({ queue: name, state }, n);
            } catch {
              // Redis unavailable: keep the last values rather than fail the whole scrape.
            }
          }),
        );
      },
    });
  }

  register(name: string, inspector: Queue): void {
    this.queues.set(name, inspector);
  }
}

export interface WorkerEventOptions<R> {
  queueName: string;
  metrics: MetricsService;
  logger: PinoLogger;
  /** Maps a job's return value to the `jobs_total` result label. Defaults to "completed". */
  resultLabel?: (result: R) => string;
}

/**
 * Shared metrics and logging for every worker: completed and failed jobs, retry vs final,
 * transient vs permanent (UnrecoverableError).
 */
export function attachWorkerEvents<R>(worker: Worker, opts: WorkerEventOptions<R>): void {
  const { queueName, metrics, logger } = opts;

  worker.on('completed', (job: Job, result: R) => {
    const label = opts.resultLabel?.(result) ?? 'completed';
    metrics.jobs.inc({ queue: queueName, result: label });
    logger.debug(
      { event: 'JOB_COMPLETED', queue: queueName, jobId: job.id, result: label },
      'job completed',
    );
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    const permanent = err instanceof UnrecoverableError || err.name === 'UnrecoverableError';
    const attempts = job?.opts.attempts ?? 1;
    const final = permanent || (job?.attemptsMade ?? 0) >= attempts;
    metrics.jobs.inc({ queue: queueName, result: final ? 'failed' : 'retrying' });
    const log = final ? logger.error.bind(logger) : logger.warn.bind(logger);
    log(
      {
        event: 'JOB_FAILED',
        queue: queueName,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        permanent,
        final,
        err: err.message,
      },
      final ? 'job failed permanently' : 'job failed, will retry',
    );
  });

  worker.on('error', (err: Error) =>
    logger.warn({ event: 'WORKER_ERROR', queue: queueName, err: err.message }, 'worker error'),
  );
}

/** Counts jobs currently inside a processor, so shutdown knows whether there is work to drain. */
export class InFlight {
  private n = 0;

  get count(): number {
    return this.n;
  }

  async track<T>(work: () => Promise<T>): Promise<T> {
    this.n++;
    try {
      return await work();
    } finally {
      this.n--;
    }
  }
}

const IDLE_CLOSE_MS = 2_000;
const FORCE_CLOSE_MS = 1_000;

/**
 * Closes a BullMQ worker without ever hanging shutdown (section 34).
 *
 * Two BullMQ behaviours shape this (both found in e2e testing):
 *   - a graceful `close()` on a worker that never connected waits for the connection forever;
 *   - `close()` caches its first call, so a later `close(true)` returns the same stuck
 *     promise and cannot rescue it.
 *
 * So the choice between graceful and forced is made up front:
 *   - idle (no job inside a processor): `close(true)`. Nothing needs draining, and a forced
 *     close disconnects even a client that is still trying to connect. A job fetched in the
 *     instant between the check and the close is not lost: its lock expires and BullMQ hands it
 *     to another worker, which is safe because every job here is idempotent.
 *   - busy: graceful `close()` for up to JOB_TIMEOUT_MS + 1s, how long a job may legitimately
 *     take; if that expires, a hard `disconnect()` instead of another close.
 * Config validation keeps SHUTDOWN_TIMEOUT_MS above JOB_TIMEOUT_MS, so the process-level force
 * exit never cuts a job short.
 */
export async function closeWorker(
  worker: Worker,
  opts: { inFlight: InFlight; jobTimeoutMs: number; queueName: string; logger: PinoLogger },
): Promise<void> {
  const active = opts.inFlight.count;
  if (active === 0) {
    opts.logger.info(
      { event: 'WORKER_STOPPING', queue: opts.queueName, activeJobs: 0 },
      'closing idle worker',
    );
    await settlesWithin(worker.close(true), IDLE_CLOSE_MS);
    return;
  }

  const graceMs = opts.jobTimeoutMs + 1_000;
  opts.logger.info(
    { event: 'WORKER_STOPPING', queue: opts.queueName, activeJobs: active, graceMs },
    'draining active jobs',
  );
  if (await settlesWithin(worker.close(), graceMs)) return;

  opts.logger.warn(
    { event: 'WORKER_FORCE_CLOSED', queue: opts.queueName, activeJobs: opts.inFlight.count },
    'worker did not drain in time; disconnecting',
  );
  await settlesWithin(worker.disconnect(), FORCE_CLOSE_MS);
}

/** Closes a Queue (a producer or inspector) with a bound; nothing waits on it for correctness. */
export async function closeQueue(queue: Queue): Promise<void> {
  await settlesWithin(queue.close(), FORCE_CLOSE_MS);
}

/** True if `p` settled (either way) within `ms`. Never rejects. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bounds a job at JOB_TIMEOUT_MS so it finishes well inside the container stop grace period.
 * A timed-out job is retried; every job in this codebase is idempotent, so that is safe even if
 * the work did land.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`job exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
