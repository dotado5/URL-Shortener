export interface UrlValidationOptions {
  /** The service's own public base URL. Destinations on this host are rejected. */
  baseUrl: string;
  maxUrlLength: number;
  maxExpiryDays: number;
  /** Injected so tests control time. */
  now?: Date;
}

export interface ValidCreateUrlInput {
  /** Normalised by the WHATWG URL parser (lower-cased host, punycode, default port removed). */
  url: string;
  expiresAt: Date | null;
}

export type ValidationResult =
  { ok: true; value: ValidCreateUrlInput } | { ok: false; errors: string[] };

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Full date-time with an explicit offset. A bare date or a local time is rejected because its
 * meaning would depend on the server's time zone.
 */
const ISO_8601_INSTANT =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Applies every rule in requirement.md section 7.1. Pure: no I/O, no framework types,
 * so each rule is unit-testable and the same function can back other entry points later.
 */
export function validateCreateUrlInput(
  body: unknown,
  options: UrlValidationOptions,
): ValidationResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['request body must be a JSON object'] };
  }

  const input = body as Record<string, unknown>;
  const errors: string[] = [];

  const url = validateUrl(input.url, options, errors);
  const expiresAt = validateExpiresAt(input.expiresAt, options, errors);

  if (errors.length > 0 || url === undefined || expiresAt === undefined) {
    return { ok: false, errors };
  }
  return { ok: true, value: { url, expiresAt } };
}

function validateUrl(
  raw: unknown,
  options: UrlValidationOptions,
  errors: string[],
): string | undefined {
  if (raw === undefined || raw === null) {
    errors.push('url is required');
    return undefined;
  }
  if (typeof raw !== 'string') {
    errors.push('url must be a string');
    return undefined;
  }
  if (raw.length === 0) {
    errors.push('url is required');
    return undefined;
  }
  if (raw.length > options.maxUrlLength) {
    errors.push(`url must be at most ${options.maxUrlLength} characters`);
    return undefined;
  }
  // The URL parser silently strips these; accepting them would store something the client did not send.
  if (raw !== raw.trim() || /\s/.test(raw) || hasControlCharacter(raw)) {
    errors.push('url must not contain whitespace or control characters');
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    errors.push('url must be a valid absolute URL');
    return undefined;
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    errors.push('url must use http or https');
    return undefined;
  }
  if (parsed.hostname.length === 0) {
    errors.push('url must include a host');
    return undefined;
  }
  if (sameHost(parsed, options.baseUrl)) {
    errors.push('url must not point at this service');
    return undefined;
  }

  const normalised = parsed.href;
  if (normalised.length > options.maxUrlLength) {
    errors.push(`url must be at most ${options.maxUrlLength} characters`);
    return undefined;
  }
  return normalised;
}

function validateExpiresAt(
  raw: unknown,
  options: UrlValidationOptions,
  errors: string[],
): Date | null | undefined {
  if (raw === undefined || raw === null) return null;

  if (typeof raw !== 'string' || !ISO_8601_INSTANT.test(raw)) {
    errors.push(
      'expiresAt must be an ISO 8601 timestamp with a time zone, e.g. 2027-01-01T00:00:00Z',
    );
    return undefined;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    errors.push(
      'expiresAt must be an ISO 8601 timestamp with a time zone, e.g. 2027-01-01T00:00:00Z',
    );
    return undefined;
  }
  // `new Date('2026-02-31T00:00:00Z')` rolls over to March instead of failing.
  if (!isRealCalendarDate(raw)) {
    errors.push('expiresAt is not a real calendar date');
    return undefined;
  }

  const now = (options.now ?? new Date()).getTime();
  if (date.getTime() <= now) {
    errors.push('expiresAt must be in the future');
    return undefined;
  }
  if (date.getTime() > now + options.maxExpiryDays * DAY_MS) {
    errors.push(`expiresAt must be within ${options.maxExpiryDays} days from now`);
    return undefined;
  }
  return date;
}

/** Checks the literal year-month-day in the input, before any time-zone shift is applied. */
function isRealCalendarDate(raw: string): boolean {
  const [y, m, d] = raw.slice(0, 10).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function sameHost(candidate: URL, baseUrl: string): boolean {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  // `host` includes the port and the parser has already dropped default ports and lower-cased it.
  return candidate.host === base.host;
}
