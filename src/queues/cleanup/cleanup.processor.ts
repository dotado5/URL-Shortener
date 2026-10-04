import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../../config/env.schema';
import { MetricsService } from '../../metrics/metrics.service';
import { DEFAULT_JOB_OPTIONS, producerConnection, workerConnection } from '../queue-options';
import {
  InFlight,
  QueueDepthMetrics,
  attachWorkerEvents,
  closeQueue,
  closeWorker,
  withTimeout,
} from '../worker-support';
import { CleanupReport, CleanupService } from './cleanup.service';

export const CLEANUP_JOB_NAME = 'cleanup';
/** Fixed id: every replica upserts the same scheduler, so there is only ever one. */
export const CLEANUP_SCHEDULER_ID = 'url-cleanup-schedule';
/** Share of JOB_TIMEOUT_MS the sweep may use before yielding the rest to the next run. */
const BUDGET_SHARE = 0.8;
const SCHEDULER_RETRY_MS = 10_000;
/** A registration attempt that has not finished by then counts as failed and is retried. */
const SCHEDULER_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Runs the periodic cleanup (section 22) from a BullMQ job scheduler.
 *
 * Why a scheduler and not setInterval: with N worker replicas, N timers would fire N sweeps.
 * BullMQ creates one job per tick in Redis and exactly one worker takes it. Registration is an
 * idempotent upsert under a fixed id, so replicas starting together still yield one schedule.
 */
@Injectable()
export class CleanupProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private readonly inFlight = new InFlight();
  private readonly queue: Queue;
  private readonly queueName: string;
  private readonly cron: string;
  private readonly jobTimeoutMs: number;
  private readonly redisUrl: string;
  private retryTimer?: NodeJS.Timeout;
  private stopping = false;
  /** Overridable in tests. */
  private schedulerAttemptTimeoutMs = SCHEDULER_ATTEMPT_TIMEOUT_MS;

  constructor(
    config: ConfigService<Env, true>,
    private readonly cleanup: CleanupService,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
    depth: QueueDepthMetrics,
  ) {
    this.logger.setContext(CleanupProcessor.name);
    this.queueName = config.get('BULLMQ_CLEANUP_QUEUE', { infer: true });
    this.cron = config.get('CLEANUP_CRON', { infer: true });
    this.jobTimeoutMs = config.get('JOB_TIMEOUT_MS', { infer: true });
    this.redisUrl = config.get('REDIS_URL', { infer: true });

    this.queue = new Queue(this.queueName, {
      connection: producerConnection(this.redisUrl, 2_000),
    });
    this.queue.on('error', () => undefined);
    depth.register(this.queueName, this.queue);
  }

  onModuleInit(): void {
    this.worker = new Worker(
      this.queueName,
      (job) => this.inFlight.track(() => this.process(job)),
      {
        connection: workerConnection(this.redisUrl),
        // One sweep at a time per replica. Across replicas, SKIP LOCKED keeps overlaps safe.
        concurrency: 1,
      },
    );
    attachWorkerEvents<CleanupReport>(this.worker, {
      queueName: this.queueName,
      metrics: this.metrics,
      logger: this.logger,
    });
    // Deliberately not awaited. BullMQ waits for a Redis connection before upserting, so awaiting
    // here blocked the whole worker boot, including its health endpoint, while Redis was down
    // (found in Docker verification). The worker must come up, report not-ready, and register
    // the schedule once Redis is reachable.
    void this.ensureScheduler();
  }

  /**
   * Upserts the schedule. Never throws and never hangs: each attempt is bounded, and a failed
   * attempt is retried in the background every SCHEDULER_RETRY_MS until it succeeds.
   */
  async ensureScheduler(): Promise<boolean> {
    try {
      await withTimeout(
        this.queue.upsertJobScheduler(
          CLEANUP_SCHEDULER_ID,
          { pattern: this.cron, tz: 'UTC' },
          {
            name: CLEANUP_JOB_NAME,
            data: {},
            opts: {
              attempts: DEFAULT_JOB_OPTIONS.attempts,
              backoff: DEFAULT_JOB_OPTIONS.backoff,
              removeOnComplete: { count: 100 },
              removeOnFail: DEFAULT_JOB_OPTIONS.removeOnFail,
            },
          },
        ),
        this.schedulerAttemptTimeoutMs,
      );
      this.logger.info(
        { event: 'CLEANUP_SCHEDULED', queue: this.queueName, cron: this.cron },
        'cleanup schedule registered',
      );
      return true;
    } catch (err) {
      this.logger.warn(
        {
          event: 'CLEANUP_SCHEDULE_FAILED',
          retryInMs: SCHEDULER_RETRY_MS,
          err: err instanceof Error ? err.message : String(err),
        },
        'could not register cleanup schedule; retrying',
      );
      if (!this.stopping) {
        this.retryTimer = setTimeout(() => void this.ensureScheduler(), SCHEDULER_RETRY_MS);
        this.retryTimer.unref();
      }
      return false;
    }
  }

  async process(job: Job, now: Date = new Date()): Promise<CleanupReport> {
    if (job.name !== CLEANUP_JOB_NAME) {
      throw new UnrecoverableError(`unknown job "${job.name}" on ${this.queueName}`);
    }
    const end = this.metrics.jobDuration.startTimer({ queue: this.queueName });
    try {
      const report = await withTimeout(
        this.cleanup.run(now, Math.floor(this.jobTimeoutMs * BUDGET_SHARE)),
        this.jobTimeoutMs,
      );
      this.metrics.cleanupRows.inc({ action: 'expired_deactivated' }, report.expiredDeactivated);
      this.metrics.cleanupRows.inc({ action: 'click_events_deleted' }, report.clickEventsDeleted);
      this.logger.info(
        { event: 'CLEANUP_COMPLETED', jobId: job.id, ...report },
        'cleanup run finished',
      );
      return report;
    } finally {
      end();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.worker) {
      await closeWorker(this.worker, {
        inFlight: this.inFlight,
        jobTimeoutMs: this.jobTimeoutMs,
        queueName: this.queueName,
        logger: this.logger,
      });
    }
    await closeQueue(this.queue);
  }
}
