import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

/**
 * Records request count and duration per *route pattern* (e.g. `/api/urls/:shortCode`),
 * never per concrete path, so cardinality stays bounded.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const route = routePattern(req);
    const method = req.method;
    const end = this.metrics.httpRequestDuration.startTimer({ route, method });

    return next.handle().pipe(
      finalize(() => {
        end();
        this.metrics.httpRequestsTotal.inc({ route, method, status: String(res.statusCode) });
      }),
    );
  }
}

export function routePattern(req: Request): string {
  // Express types `req.route` as `any`; narrow it before touching it.
  const route = req.route as { path?: unknown } | undefined;
  const path = typeof route?.path === 'string' ? route.path : '';
  const base = (req.baseUrl ?? '') + path;
  return base || 'unmatched';
}
