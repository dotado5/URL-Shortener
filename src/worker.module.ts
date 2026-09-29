import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggerModule } from './common/logger/logger.module';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Background worker process. Exposes only health and metrics over HTTP.
 * BullMQ processors register here from Milestone 6; producers never do.
 */
@Module({
  imports: [ConfigModule, LoggerModule, PrismaModule, MetricsModule, HealthModule],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class WorkerModule {}
