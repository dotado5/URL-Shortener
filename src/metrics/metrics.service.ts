import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Single Prometheus registry for the process. Metric names follow section 32 of the requirements.
 * Later milestones add their instruments here so the names live in one place.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  readonly registry = new Registry();

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by route, method and status',
    labelNames: ['route', 'method', 'status'] as const,
    registers: [this.registry],
  });

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['route', 'method'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  readonly dbQueryDuration = new Histogram({
    name: 'db_query_duration_seconds',
    help: 'Database query duration in seconds',
    labelNames: ['model', 'operation'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });

  /**
   * op: get | set | set_negative | del | del_negative
   * result: hit | miss | negative_hit | ok | error | bypass (breaker open) | skipped (not cacheable)
   * Hit ratio = hit / (hit + miss + negative_hit + error + bypass) for op="get".
   */
  readonly cacheOperations = new Counter({
    name: 'cache_operations_total',
    help: 'Cache operations by operation and result',
    labelNames: ['op', 'result'] as const,
    registers: [this.registry],
  });

  readonly cacheBreakerState = new Gauge({
    name: 'cache_breaker_state',
    help: 'Cache circuit breaker state: 0 closed, 1 open, 2 half-open',
    registers: [this.registry],
  });

  /** result: allowed | blocked | unavailable (Redis failed; the fail mode then decides). */
  readonly rateLimitDecisions = new Counter({
    name: 'rate_limit_decisions_total',
    help: 'Rate limiter decisions by policy and result',
    labelNames: ['route', 'result'] as const,
    registers: [this.registry],
  });

  /** API side. result: ok | error (the click is dropped, the redirect is unaffected). */
  readonly jobsCreated = new Counter({
    name: 'jobs_created_total',
    help: 'Jobs enqueued by queue and result',
    labelNames: ['queue', 'result'] as const,
    registers: [this.registry],
  });

  /** Worker side. result: completed | duplicate | failed | retrying */
  readonly jobs = new Counter({
    name: 'jobs_total',
    help: 'Jobs processed by queue and outcome',
    labelNames: ['queue', 'result'] as const,
    registers: [this.registry],
  });

  readonly jobDuration = new Histogram({
    name: 'job_duration_seconds',
    help: 'Job processing duration in seconds',
    labelNames: ['queue'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5],
    registers: [this.registry],
  });

  /** action: expired_deactivated | click_events_deleted */
  readonly cleanupRows = new Counter({
    name: 'cleanup_rows_total',
    help: 'Rows changed by the cleanup job',
    labelNames: ['action'] as const,
    registers: [this.registry],
  });

  readonly dbPoolConnections = new Gauge({
    name: 'db_pool_connections',
    help: 'node-postgres pool connections by state',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });

  private readonly defaultMetricsTimer?: NodeJS.Timeout;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: '' });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  onModuleDestroy(): void {
    if (this.defaultMetricsTimer) clearInterval(this.defaultMetricsTimer);
    this.registry.clear();
  }
}
