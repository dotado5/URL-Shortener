import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { hashIp } from '../../common/utils/ip';
import type { Env } from '../../config/env.schema';
import { MetricsService } from '../../metrics/metrics.service';
import { DEFAULT_JOB_OPTIONS, producerConnection } from '../queue-options';
import { closeQueue } from '../worker-support';
import { ANALYTICS_JOB_NAME, ClickEvent, truncateHeader } from './click-event';

export interface ClickContext {
  shortCode: string;
  ip: string;
  userAgent: string | string[] | undefined;
  referer: string | string[] | undefined;
}

/**
 * API-side producer. `record` is fire-and-forget by contract (D10): it never throws, never
 * rejects, and the redirect never awaits it. If Redis is down the click is lost and counted
 * as jobs_created_total{result="error"}.
 */
@Injectable()
export class AnalyticsProducer implements OnModuleDestroy {
  readonly queue: Queue;
  private readonly queueName: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnalyticsProducer.name);
    this.queueName = config.get('BULLMQ_ANALYTICS_QUEUE', { infer: true });
    this.secret = config.get('IP_HASH_SECRET', { infer: true });
    this.timeoutMs = config.get('ANALYTICS_ENQUEUE_TIMEOUT_MS', { infer: true });
    this.queue = new Queue(this.queueName, {
      connection: producerConnection(config.get('REDIS_URL', { infer: true }), this.timeoutMs),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    // Without a listener, connection errors would surface as unhandled 'error' events.
    this.queue.on('error', (err: Error) =>
      this.logger.debug({ event: 'QUEUE_CONNECTION_ERROR', err: err.message }, 'queue error'),
    );
  }

  /** Builds the payload. The IP is hashed here so it never leaves the API process in clear. */
  buildEvent(ctx: ClickContext, now: Date = new Date()): ClickEvent {
    return {
      eventId: randomUUID(),
      shortCode: ctx.shortCode,
      timestamp: now.toISOString(),
      userAgent: truncateHeader(ctx.userAgent),
      referer: truncateHeader(ctx.referer),
      ipHash: hashIp(ctx.ip, this.secret),
    };
  }

  record(ctx: ClickContext): void {
    const event = this.buildEvent(ctx);
    void this.enqueue(event);
  }

  /** Resolves true when enqueued, false when dropped. Never rejects. Exposed for tests. */
  async enqueue(event: ClickEvent): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('enqueue timed out')), this.timeoutMs);
    });
    try {
      // jobId = eventId: BullMQ ignores a second add with the same id while the first is retained.
      await Promise.race([
        this.queue.add(ANALYTICS_JOB_NAME, event, { jobId: event.eventId }),
        timeout,
      ]);
      this.metrics.jobsCreated.inc({ queue: this.queueName, result: 'ok' });
      this.logger.debug(
        { event: 'JOB_CREATED', queue: this.queueName, eventId: event.eventId },
        'job created',
      );
      return true;
    } catch (err) {
      this.metrics.jobsCreated.inc({ queue: this.queueName, result: 'error' });
      this.logger.warn(
        {
          event: 'ANALYTICS_ENQUEUE_FAILED',
          shortCode: event.shortCode,
          err: err instanceof Error ? err.message : String(err),
        },
        'click dropped',
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await closeQueue(this.queue);
  }
}
