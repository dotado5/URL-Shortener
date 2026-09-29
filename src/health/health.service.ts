import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type CheckState = 'up' | 'down' | 'degraded';

export interface ReadinessReport {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, CheckState>;
}

/**
 * A dependency check. `critical` dependencies take the process out of rotation when down;
 * non-critical ones only mark it degraded (section 33).
 */
export interface HealthIndicator {
  readonly name: string;
  readonly critical: boolean;
  check(): Promise<boolean>;
}

@Injectable()
export class HealthService {
  private readonly indicators: HealthIndicator[] = [];
  private shuttingDown = false;

  constructor(prisma: PrismaService) {
    this.register({
      name: 'database',
      critical: true,
      check: () =>
        prisma.ping().then(
          () => true,
          () => false,
        ),
    });
  }

  register(indicator: HealthIndicator): void {
    this.indicators.push(indicator);
  }

  /** Called from shutdown hooks so the load balancer stops routing before the server closes. */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  async readiness(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.indicators.map(async (i) => [i, await i.check()] as const),
    );

    const checks: Record<string, CheckState> = {};
    let status: ReadinessReport['status'] = this.shuttingDown ? 'down' : 'ok';

    for (const [indicator, ok] of results) {
      if (ok) {
        checks[indicator.name] = 'up';
        continue;
      }
      if (indicator.critical) {
        checks[indicator.name] = 'down';
        status = 'down';
      } else {
        checks[indicator.name] = 'degraded';
        if (status === 'ok') status = 'degraded';
      }
    }

    return { status, checks };
  }
}
