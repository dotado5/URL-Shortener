import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ClickEvent } from './click-event';

export type RecordResult = 'recorded' | 'duplicate' | 'url_missing';

/**
 * Writes one click with exactly-once effect under at-least-once delivery (section 24).
 *
 * A single statement, so it is atomic without an explicit transaction:
 *   - insert the ClickEvent, skipping it if this eventId was already recorded
 *   - increment clickCount only for a row the insert actually created
 *
 * Replaying the same event therefore changes nothing. The unique index on eventId, not the
 * application, is what enforces it, so it also holds across concurrent workers.
 *
 * Tagged-template $executeRaw is parameterised: no value is ever interpolated into the SQL text.
 */
@Injectable()
export class ClickRecorder {
  constructor(private readonly prisma: PrismaService) {}

  async record(event: ClickEvent): Promise<RecordResult> {
    const updated = await this.prisma.$executeRaw`
      WITH target AS (
        SELECT id FROM "Url" WHERE "shortCode" = ${event.shortCode}
      ),
      inserted AS (
        INSERT INTO "ClickEvent" ("id", "eventId", "urlId", "createdAt", "userAgent", "referer", "ipHash")
        SELECT ${randomUUID()}, ${event.eventId}, target.id,
               (${event.timestamp}::timestamptz AT TIME ZONE 'UTC'),
               ${event.userAgent}, ${event.referer}, ${event.ipHash}
        FROM target
        ON CONFLICT ("eventId") DO NOTHING
        RETURNING "urlId"
      )
      UPDATE "Url" SET "clickCount" = "clickCount" + 1
      WHERE id IN (SELECT "urlId" FROM inserted)`;

    if (updated === 1) return 'recorded';

    // Nothing changed: either this event was already recorded, or the URL does not exist.
    const existing = await this.prisma.clickEvent.findUnique({
      where: { eventId: event.eventId },
      select: { id: true },
    });
    return existing ? 'duplicate' : 'url_missing';
  }
}
