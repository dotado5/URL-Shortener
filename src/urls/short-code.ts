import { randomInt } from 'node:crypto';

export const SHORT_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Root-level path segments the application serves itself. A short code matching one of these
 * (case-insensitively) would be unreachable behind the real route, so generation rejects it.
 * Entries containing characters outside Base62 can never be generated; they are listed so the
 * redirect route can refuse them by the same rule.
 */
export const RESERVED_CODES: ReadonlySet<string> = new Set([
  'api',
  'health',
  'metrics',
  'docs',
  'favicon.ico',
  'robots.txt',
]);

/** Shape accepted on lookup. Anything else is a 404 without touching Redis or PostgreSQL. */
export const SHORT_CODE_PATTERN = /^[0-9A-Za-z]{6,12}$/;

export function isReservedCode(code: string): boolean {
  return RESERVED_CODES.has(code.toLowerCase());
}

export function isWellFormedShortCode(code: unknown): code is string {
  return typeof code === 'string' && SHORT_CODE_PATTERN.test(code) && !isReservedCode(code);
}

export type RandomIndex = (exclusiveMax: number) => number;

/**
 * Generates one Base62 code from a CSPRNG. `crypto.randomInt` is uniform, so there is no
 * modulo bias. Reserved words are re-rolled; the loop is bounded so a broken random source
 * cannot spin forever.
 */
export function generateShortCode(length: number, random: RandomIndex = randomInt): string {
  if (!Number.isInteger(length) || length < 6 || length > 12) {
    throw new RangeError(`short code length must be an integer between 6 and 12, got ${length}`);
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += SHORT_CODE_ALPHABET[random(SHORT_CODE_ALPHABET.length)];
    }
    if (!isReservedCode(code)) return code;
  }
  throw new Error('could not generate a non-reserved short code');
}
