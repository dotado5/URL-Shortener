import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../../config/env.schema';
import { HealthService } from '../../health/health.service';
import { MetricsService } from '../../metrics/metrics.service';
import { producerConnection, workerConnection } from '../queue-options';
import {
  InFlight,
  QueueDepthMetrics,
  attachWorkerEvents,
  closeQueue,
  closeWorker,
  withTimeout,
} from '../worker-support';
import { clickEventSchema } from './click-event';
import { ClickRecorder, RecordResult } from './click-recorder';

export { withTimeout } from '../worker-support';

/**
 * Worker-side consumer (sections 21-24). Lives only in the worker process.
 *
 * Transient failures (database down, deadlock, timeout) throw normally and BullMQ retries with
 * exponential backoff. Failures that can never succeed (malformed payload, URL row missing)
 * throw UnrecoverableError and go straight to the failed set without wasting retries.
 */
@Injectable()
export class AnalyticsProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private readonly inFlight = new InFlight();
  /** Used for queue-depth metrics and the readiness ping; never for blocking reads. */
  private readonly inspector: Queue;
  private readonly queueName: string;
  private readonly concurrency: number;
  private readonly jobTimeoutMs: number;
  private readonly redisUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly recorder: ClickRecorder,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
    health: HealthService,
    depth: QueueDepthMetrics,
  ) {
    this.logger.setContext(AnalyticsProcessor.name);
    this.queueName = config.get('BULLMQ_ANALYTICS_QUEUE', { infer: true });
    this.concurrency = config.get('ANALYTICS_WORKER_CONCURRENCY', { infer: true });
    this.jobTimeoutMs = config.get('JOB_TIMEOUT_MS', { infer: true });
    this.redisUrl = config.get('REDIS_URL', { infer: true });

    this.inspector = new Queue(this.queueName, {
      connection: producerConnection(this.redisUrl, 1_000),
    });
    this.inspector.on('error', () => undefined);
    depth.register(this.queueName, this.inspector);

    // The worker can do nothing without Redis, so unlike the API it is a critical dependency.
    health.register({ name: 'redis', critical: true, check: () => this.pingRedis() });
  }

  onModuleInit(): void {
    this.worker = new Worker(
      this.queueName,
      (job) => this.inFlight.track(() => this.process(job)),
      {
        connection: workerConnection(this.redisUrl),
        concurrency: this.concurrency,
      },
    );
    attachWorkerEvents<RecordResult>(this.worker, {
      queueName: this.queueName,
      metrics: this.metrics,
      logger: this.logger,
      resultLabel: (r) => (r === 'duplicate' ? 'duplicate' : 'completed'),
    });
    this.logger.info(
      { event: 'WORKER_STARTED', queue: this.queueName, concurrency: this.concurrency },
      'analytics worker started',
    );
  }

  async process(job: Job): Promise<RecordResult> {
    const parsed = clickEventSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new UnrecoverableError(`invalid click payload: ${parsed.error.issues[0]?.message}`);
    }

    this.logger.debug(
      { event: 'JOB_STARTED', queue: this.queueName, jobId: job.id },
      'job started',
    );
    const end = this.metrics.jobDuration.startTimer({ queue: this.queueName });
    try {
      const result = await withTimeout(this.recorder.record(parsed.data), this.jobTimeoutMs);
      if (result === 'url_missing') {
        throw new UnrecoverableError(`short code ${parsed.data.shortCode} does not exist`);
      }
      return result;
    } finally {
      end();
    }
  }

  /**
   * BullMQ 6 hides the raw client behind its backend abstraction, so readiness uses a cheap real
   * round trip through the queue. The inspector connection's 1s command timeout bounds it.
   */
  private async pingRedis(): Promise<boolean> {
    try {
      await this.inspector.getJobCounts('waiting');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `worker.close()` stops taking new jobs and waits for active ones to finish (section 34),
   * so a SIGTERM never abandons a job mid-transaction.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await closeWorker(this.worker, {
        inFlight: this.inFlight,
        jobTimeoutMs: this.jobTimeoutMs,
        queueName: this.queueName,
        logger: this.logger,
      });
    }
    await closeQueue(this.inspector);
  }
}
