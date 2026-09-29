import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface IssuedDeleteToken {
  /** Returned to the client exactly once. Never stored, never logged. */
  token: string;
  /** SHA-256 hex digest, 64 characters. This is what the database holds. */
  hash: string;
}

const TOKEN_BYTES = 32;
const HASH_HEX_LENGTH = 64;

/**
 * The token is 256 bits from a CSPRNG, so a fast unsalted hash is appropriate: there is no
 * low-entropy secret to protect against offline guessing, only a lookup value to keep out of
 * the database in plain form.
 */
export function hashDeleteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issueDeleteToken(): IssuedDeleteToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashDeleteToken(token) };
}

/**
 * Constant-time comparison of the presented token against the stored hash.
 * Both sides are fixed-length digests, so `timingSafeEqual` never throws on length mismatch
 * and the comparison time does not depend on the presented token's length or content.
 */
export function verifyDeleteToken(presented: unknown, storedHash: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 256) {
    return false;
  }
  if (storedHash.length !== HASH_HEX_LENGTH) return false;

  const a = Buffer.from(hashDeleteToken(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
