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
