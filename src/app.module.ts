import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggerModule } from './common/logger/logger.module';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedirectModule } from './redirect/redirect.module';
import { UrlsModule } from './urls/urls.module';

/**
 * HTTP API process. Queue producers join here in Milestone 6; processors never do.
 *
 * RedirectModule MUST stay last: its `GET /:shortCode` catch-all would otherwise shadow
 * single-segment routes such as `/metrics`. Express matches in registration order.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    PrismaModule,
    MetricsModule,
    HealthModule,
    UrlsModule,
    RedirectModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule {}
