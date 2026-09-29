import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

export interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId?: string;
}

const REASON: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * Produces the single error shape from section 28 for every failure.
 * 5xx details never reach the client. Body-parser errors (which carry a `status`) keep their code.
 */
@Injectable()
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(HttpExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const body = toErrorBody(exception);
    if (req.id) body.requestId = String(req.id);

    if (body.statusCode >= 500) {
      this.logger.error(
        {
          err: exception,
          event: 'UNHANDLED_ERROR',
          requestId: body.requestId,
          statusCode: body.statusCode,
        },
        'request failed',
      );
    }

    if (res.headersSent) return;
    res.status(body.statusCode).json(body);
  }
}

export function toErrorBody(exception: unknown): ErrorBody {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const message = extractMessage(payload) ?? exception.message;
    return { statusCode: status, error: REASON[status] ?? exception.name, message };
  }

  // Errors raised by express middleware (body-parser etc.) carry a numeric status.
  const status = numericStatus(exception);
  if (status && status >= 400 && status < 500) {
    return {
      statusCode: status,
      error: REASON[status] ?? 'Error',
      message: REASON[status] ?? 'Request rejected',
    };
  }

  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    error: REASON[500],
    message: 'An unexpected error occurred',
  };
}

function extractMessage(payload: string | object): string | string[] | undefined {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && 'message' in payload) {
    const m: unknown = payload.message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m) && m.every((x): x is string => typeof x === 'string')) return m;
  }
  return undefined;
}

function numericStatus(e: unknown): number | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const o = e as { status?: unknown; statusCode?: unknown };
  const s =
    typeof o.status === 'number'
      ? o.status
      : typeof o.statusCode === 'number'
        ? o.statusCode
        : undefined;
  return s;
}
