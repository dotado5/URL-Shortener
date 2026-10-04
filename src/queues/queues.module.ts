import { Module } from '@nestjs/common';
import { AnalyticsProcessor } from './analytics/analytics.processor';
import { AnalyticsProducer } from './analytics/analytics.producer';
import { ClickRecorder } from './analytics/click-recorder';
import { CleanupProcessor } from './cleanup/cleanup.processor';
import { CleanupService } from './cleanup/cleanup.service';
import { QueueDepthMetrics } from './worker-support';

/** Imported by AppModule only. Producers enqueue; nothing here consumes. */
@Module({
  providers: [AnalyticsProducer],
  exports: [AnalyticsProducer],
})
export class QueueProducersModule {}

/** Imported by WorkerModule only. Processors consume; the API never loads them. */
@Module({
  providers: [
    QueueDepthMetrics,
    ClickRecorder,
    AnalyticsProcessor,
    CleanupService,
    CleanupProcessor,
  ],
  exports: [ClickRecorder, AnalyticsProcessor, CleanupService, CleanupProcessor],
})
export class QueueWorkersModule {}
