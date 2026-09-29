import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Env } from '../../config/env.schema';
import { assignRequestId } from './request-id';

export { REQUEST_ID_HEADER } from './request-id';

/** Paths whose per-request "request completed" log line is noise. Explicit events still log. */
const QUIET_PATHS = new Set(['/health/live', '/health/ready', '/metrics']);

/**
 * Structured JSON logging with a request id on every line.
 * The id is taken from an incoming `X-Request-Id` only when a trusted proxy is configured,
 * otherwise generated, and is always echoed back on the response.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const trustProxy = config.get('TRUST_PROXY', { infer: true }) !== '';
        // Pretty output is a dev dependency. Containers built with --omit=dev fall back to JSON
        // instead of crashing at boot, even when NODE_ENV is development.
        const isDev =
          config.get('NODE_ENV', { infer: true }) === 'development' && isPrettyTransportAvailable();
        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            // Reuses the id assigned by the first middleware in bootstrap.ts.
            genReqId: (req: IncomingMessage, res: ServerResponse) =>
              assignRequestId(req, res, trustProxy),
            customProps: (req: IncomingMessage) => ({ requestId: req.id }),
            autoLogging: {
              ignore: (req: IncomingMessage) => QUIET_PATHS.has((req.url ?? '').split('?')[0]),
            },
            // Never log bodies, destination URLs, or anything that could carry a token.
            serializers: {
              req: (req: { id: unknown; method: string; url: string }) => ({
                id: req.id,
                method: req.method,
                url: redactQuery(req.url),
              }),
              res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-delete-token"]',
              ],
              remove: true,
            },
            base: undefined,
            timestamp: () => `,"time":"${new Date().toISOString()}"`,
            formatters: {
              level: (label: string) => ({ level: label }),
            },
            transport: isDev
              ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
              : undefined,
          },
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}

export function isPrettyTransportAvailable(
  resolve: (id: string) => string = require.resolve,
): boolean {
  try {
    resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function redactQuery(url: string | undefined): string {
  if (!url) return '';
  const i = url.indexOf('?');
  return i === -1 ? url : `${url.slice(0, i)}?[redacted]`;
}
