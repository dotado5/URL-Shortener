import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

type WithId = IncomingMessage & { id?: unknown };

/**
 * Resolves the id for a request exactly once. The first caller wins; later callers
 * (the pino-http middleware, the exception filter) get the same value.
 *
 * An incoming `X-Request-Id` is honoured only behind a trusted proxy, and only if it is a
 * reasonable length, so a client cannot inject arbitrary values into every log line.
 */
export function assignRequestId(
  req: IncomingMessage,
  res: ServerResponse,
  trustProxy: boolean,
): string {
  const r = req as WithId;
  if (typeof r.id === 'string' && r.id.length > 0) return r.id;

  const incoming = trustProxy ? req.headers[REQUEST_ID_HEADER] : undefined;
  const id =
    typeof incoming === 'string' && /^[\w.:=-]{1,128}$/.test(incoming) ? incoming : randomUUID();

  r.id = id;
  if (!res.headersSent) res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Express middleware form. Registered first so even body-parser rejections carry an id. */
export function requestIdMiddleware(trustProxy: boolean) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    assignRequestId(req, res, trustProxy);
    next();
  };
}
