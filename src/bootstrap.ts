import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { requestIdMiddleware } from './common/logger/request-id';
import type { Env } from './config/env.schema';
import { HealthService } from './health/health.service';

/**
 * Shared HTTP app construction for the API and for e2e tests, so tests exercise the same
 * middleware, body limits, filters and headers as production.
 */
export async function createApp(rootModule: unknown): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(rootModule as never, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService<Env, true>);
  const trustProxy = config.get('TRUST_PROXY', { infer: true });
  if (trustProxy !== '') {
    app.set('trust proxy', parseTrustProxy(trustProxy));
  }
  app.disable('x-powered-by');

  // First middleware, so errors raised by later middleware (body-parser 413/400) still carry an id.
  app.use(requestIdMiddleware(trustProxy !== ''));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.useBodyParser('json', { limit: config.get('BODY_LIMIT', { infer: true }) });

  const origins = config
    .get('CORS_ORIGINS', { infer: true })
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length > 0) {
    app.enableCors({ origin: origins, methods: ['GET', 'POST', 'DELETE'], maxAge: 600 });
  }

  app.enableShutdownHooks();
  return app;
}

export function setupSwagger(app: INestApplication): void {
  const doc = new DocumentBuilder()
    .setTitle('URL Shortener API')
    .setDescription(
      [
        'Create short URLs, redirect visitors, inspect and delete links.',
        '',
        'Redirects (`GET /{shortCode}`) return `302` with `Cache-Control: private, no-store`.',
        'Rate-limited routes send `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every response and `Retry-After` on `429`.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, doc);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: { persistAuthorization: true },
  });
}

/**
 * Wires SIGTERM/SIGINT so readiness fails first, then in-flight requests drain, then Nest closes
 * providers (Prisma, Redis, queues) through their lifecycle hooks.
 */
export function installShutdownHandlers(app: INestApplication, name: string): void {
  const logger = app.get(Logger);
  const config = app.get(ConfigService<Env, true>);
  const timeoutMs = config.get('SHUTDOWN_TIMEOUT_MS', { infer: true });
  let closing = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    logger.log(`${name}: received ${signal}, shutting down`, 'Shutdown');
    app.get(HealthService).markShuttingDown();

    const force = setTimeout(() => {
      logger.error(`${name}: shutdown exceeded ${timeoutMs}ms, exiting`, undefined, 'Shutdown');
      process.exit(1);
    }, timeoutMs);
    force.unref();

    app
      .close()
      .then(() => {
        logger.log(`${name}: closed cleanly`, 'Shutdown');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error(
          `${name}: error during shutdown`,
          err instanceof Error ? err.stack : String(err),
          'Shutdown',
        );
        process.exit(1);
      });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

function parseTrustProxy(value: string): boolean | number | string | string[] {
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length === 1 ? parts[0] : parts;
}
