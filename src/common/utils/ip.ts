import { createHmac } from 'node:crypto';
import type { Request } from 'express';

/**
 * The client address as Express resolved it. With `trust proxy` configured (TRUST_PROXY),
 * Express walks X-Forwarded-For from the right and returns the first address that is not a
 * trusted proxy. The left-most entry is client-controlled and is never trusted blindly.
 * Without TRUST_PROXY this is simply the socket address.
 */
export function clientIp(req: Pick<Request, 'ip' | 'socket'>): string {
  return normalizeIp(req.ip ?? req.socket?.remoteAddress);
}

/** Folds IPv4-mapped IPv6 (`::ffff:1.2.3.4`) into plain IPv4 so both forms share one identity. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip.toLowerCase();
}

/**
 * Keyed hash of an IP (D9). Used for rate-limit keys and analytics, so a raw address never
 * reaches Redis or PostgreSQL. A plain SHA-256 of an IPv4 address can be reversed by trying all
 * 2^32 inputs; without the secret it cannot. Rotating the secret deliberately breaks linkage.
 */
export function hashIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip, 'utf8').digest('hex');
}
