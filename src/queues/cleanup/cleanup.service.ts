import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';

export interface CleanupReport {
  /** Rows whose expiry had passed and were still marked active. */
  expiredDeactivated: number;
  /** ClickEvent rows older than ANALYTICS_RETENTION_DAYS. */
  clickEventsDeleted: number;
  batches: number;
  /** False when the time budget ran out with work left; the next run continues. */
  complete: boolean;
  durationMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Periodic housekeeping (section 22). Two sweeps, each in batches of CLEANUP_BATCH_SIZE:
 *
 *  1. Mark expired URLs inactive. Informational only: the redirect path checks expiresAt on every
 *     request and never depends on this having run (D1).
 *  2. Delete ClickEvent rows past the retention period. `Url.clickCount` is a lifetime total and
 *     is not reduced; only the per-click detail is pruned.
 *
 * Safety properties:
 *  - Idempotent: every statement is conditional on current state, so a second run finds nothing.
 *  - Concurrent runs split the work: `FOR UPDATE SKIP LOCKED` means two workers never touch the
 *    same row and never wait on each other.
 *  - Short transactions: each batch is one statement, so locks are held for milliseconds.
 *  - Bounded: stops when the time budget is spent, leaving the rest for the next run, so a large
 *    backlog cannot push a job past JOB_TIMEOUT_MS.
 *  - The cutoff is computed in the application and passed in UTC, so the database session's
 *    time zone cannot shift it.
 */
@Injectable()
export class CleanupService {
  private readonly batchSize: number;
  private readonly retentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.batchSize = config.get('CLEANUP_BATCH_SIZE', { infer: true });
    this.retentionDays = config.get('ANALYTICS_RETENTION_DAYS', { infer: true });
  }

  async run(now: Date, budgetMs: number): Promise<CleanupReport> {
    const started = Date.now();
    const deadline = started + budgetMs;
    const report: CleanupReport = {
      expiredDeactivated: 0,
      clickEventsDeleted: 0,
      batches: 0,
      complete: true,
      durationMs: 0,
    };

    const expired = await this.drain(() => this.deactivateExpiredBatch(now), deadline, report);
    report.expiredDeactivated = expired.total;

    if (expired.finished) {
      const retentionCutoff = new Date(now.getTime() - this.retentionDays * DAY_MS);
      const purged = await this.drain(
        () => this.deleteOldClickEventsBatch(retentionCutoff),
        deadline,
        report,
      );
      report.clickEventsDeleted = purged.total;
      report.complete = purged.finished;
    } else {
      report.complete = false;
    }

    report.durationMs = Date.now() - started;
    return report;
  }

  /** Runs batches until one comes back short (nothing left) or the deadline passes. */
  private async drain(
    batch: () => Promise<number>,
    deadline: number,
    report: CleanupReport,
  ): Promise<{ total: number; finished: boolean }> {
    let total = 0;
    for (;;) {
      const n = await batch();
      report.batches++;
      total += n;
      if (n < this.batchSize) return { total, finished: true };
      if (Date.now() >= deadline) return { total, finished: false };
    }
  }

  deactivateExpiredBatch(now: Date): Promise<number> {
    const cutoff = now.toISOString();
    return this.prisma.$executeRaw`
      WITH batch AS (
        SELECT id FROM "Url"
        WHERE "isActive" = true
          AND "expiresAt" < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "expiresAt"
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "Url" AS u
      SET "isActive" = false, "updatedAt" = (${cutoff}::timestamptz AT TIME ZONE 'UTC')
      FROM batch
      WHERE u.id = batch.id`;
  }

  deleteOldClickEventsBatch(cutoff: Date): Promise<number> {
    const iso = cutoff.toISOString();
    return this.prisma.$executeRaw`
      WITH batch AS (
        SELECT id FROM "ClickEvent"
        WHERE "createdAt" < (${iso}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "createdAt"
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "ClickEvent" AS c
      USING batch
      WHERE c.id = batch.id`;
  }
}
