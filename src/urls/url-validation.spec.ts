import { UrlValidationOptions, validateCreateUrlInput } from './url-validation';

const NOW = new Date('2026-09-29T12:00:00.000Z');

const options: UrlValidationOptions = {
  baseUrl: 'https://short.ly',
  maxUrlLength: 2048,
  maxExpiryDays: 3650,
  now: NOW,
};

function expectValid(body: unknown, opts = options) {
  const result = validateCreateUrlInput(body, opts);
  if (!result.ok) throw new Error(`expected valid, got: ${result.errors.join('; ')}`);
  return result.value;
}

function expectInvalid(body: unknown, opts = options): string[] {
  const result = validateCreateUrlInput(body, opts);
  if (result.ok) throw new Error(`expected invalid, got: ${JSON.stringify(result.value)}`);
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}

describe('validateCreateUrlInput', () => {
  describe('body shape', () => {
    it.each([null, undefined, 'https://example.com', 42, true, []])('rejects body %p', (body) => {
      expect(expectInvalid(body)).toEqual(['request body must be a JSON object']);
    });

    it('ignores unknown properties', () => {
      const value = expectValid({ url: 'https://example.com', shortCode: 'custom', admin: true });
      expect(value).toEqual({ url: 'https://example.com/', expiresAt: null });
    });
  });

  describe('rule: url is present, a string, and an absolute URL', () => {
    it('passes for a normal https URL', () => {
      expect(expectValid({ url: 'https://example.com/a/very/long/path?x=1#frag' }).url).toBe(
        'https://example.com/a/very/long/path?x=1#frag',
      );
    });

    it('passes for http', () => {
      expect(expectValid({ url: 'http://example.com' }).url).toBe('http://example.com/');
    });

    it.each([
      ['missing', {}],
      ['null', { url: null }],
      ['empty', { url: '' }],
    ])('fails when url is %s', (_name, body) => {
      expect(expectInvalid(body)).toContain('url is required');
    });

    it.each([42, true, {}, ['https://example.com']])('fails when url is %p', (url) => {
      expect(expectInvalid({ url })).toContain('url must be a string');
    });

    it.each(['example.com', '/relative/path', '//example.com', 'not a url', 'http://', 'https://'])(
      'fails for non-absolute or unparseable %p',
      (url) => {
        const errors = expectInvalid({ url });
        expect(errors.join()).toMatch(/valid absolute URL|whitespace|http or https/);
      },
    );
  });

  describe('rule: scheme must be http or https', () => {
    it.each([
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.com/file',
      'mailto:a@example.com',
      'ws://example.com',
      'chrome://settings',
      'JAVASCRIPT:alert(1)',
    ])('fails for %p', (url) => {
      expect(expectInvalid({ url })).toContain('url must use http or https');
    });

    it('passes regardless of scheme case', () => {
      expect(expectValid({ url: 'HTTPS://EXAMPLE.COM/Path' }).url).toBe('https://example.com/Path');
    });
  });

  describe('rule: url length', () => {
    const small = { ...options, maxUrlLength: 64 };

    it('passes at exactly the limit', () => {
      const url = 'https://example.com/' + 'a'.repeat(64 - 'https://example.com/'.length);
      expect(url).toHaveLength(64);
      expect(expectValid({ url }, small).url).toBe(url);
    });

    it('fails one character over the limit', () => {
      const url = 'https://example.com/' + 'a'.repeat(65 - 'https://example.com/'.length);
      expect(expectInvalid({ url }, small)).toContain('url must be at most 64 characters');
    });

    it('fails when normalisation pushes the URL over the limit', () => {
      // Each non-ASCII path character becomes nine percent-encoded characters.
      const url = 'https://example.com/' + '日'.repeat(20);
      expect(url.length).toBeLessThanOrEqual(64);
      expect(expectInvalid({ url }, small)).toContain('url must be at most 64 characters');
    });
  });

  describe('rule: no whitespace or control characters', () => {
    it.each([
      ['leading space', ' https://example.com'],
      ['trailing space', 'https://example.com '],
      ['embedded space', 'https://example.com/a b'],
      ['tab', 'https://example.com/\tx'],
      ['newline', 'https://example.com/\nx'],
      ['null byte', 'https://example.com/\u0000'],
    ])('fails for %s', (_name, url) => {
      expect(expectInvalid({ url })).toContain(
        'url must not contain whitespace or control characters',
      );
    });
  });

  describe('rule: url must not point at this service', () => {
    it.each([
      'https://short.ly/a8K2xPq',
      'http://short.ly/a8K2xPq',
      'https://SHORT.LY/x',
      'https://short.ly:443/x',
      'https://short.ly',
    ])('fails for %p', (url) => {
      expect(expectInvalid({ url })).toContain('url must not point at this service');
    });

    it.each(['https://short.ly.example.com', 'https://notshort.ly', 'https://sub.short.ly'])(
      'passes for the different host %p',
      (url) => {
        expectValid({ url });
      },
    );

    it('compares ports, so another local service is allowed in development', () => {
      const dev = { ...options, baseUrl: 'http://localhost:3000' };
      expectValid({ url: 'http://localhost:8080/page' }, dev);
      expect(expectInvalid({ url: 'http://localhost:3000/abc1234' }, dev)).toContain(
        'url must not point at this service',
      );
    });
  });

  describe('rule: expiresAt is optional', () => {
    it.each([
      ['omitted', { url: 'https://example.com' }],
      ['null', { url: 'https://example.com', expiresAt: null }],
    ])('passes when %s', (_name, body) => {
      expect(expectValid(body).expiresAt).toBeNull();
    });
  });

  describe('rule: expiresAt must be a valid ISO 8601 timestamp', () => {
    it.each([
      '2027-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00Z',
      '2027-01-01T00:00Z',
      '2027-01-01T01:00:00+01:00',
      '2027-01-01T00:00:00.123456-05:00',
    ])('passes for %p', (expiresAt) => {
      const value = expectValid({ url: 'https://example.com', expiresAt });
      expect(value.expiresAt).toBeInstanceOf(Date);
    });

    it('converts offsets to the same instant', () => {
      const a = expectValid({ url: 'https://example.com', expiresAt: '2027-01-01T01:00:00+01:00' });
      const b = expectValid({ url: 'https://example.com', expiresAt: '2027-01-01T00:00:00Z' });
      expect(a.expiresAt?.getTime()).toBe(b.expiresAt?.getTime());
    });

    it.each([
      ['date only', '2027-01-01'],
      ['no time zone', '2027-01-01T00:00:00'],
      ['space separator', '2027-01-01 00:00:00Z'],
      ['free text', 'tomorrow'],
      ['RFC 2822', 'Fri, 01 Jan 2027 00:00:00 GMT'],
      ['month 13', '2027-13-01T00:00:00Z'],
      ['hour 25', '2027-01-01T25:00:00Z'],
      ['empty', ''],
      ['number', 1798761600000],
      ['boolean', true],
      ['object', {}],
    ])('fails for %s', (_name, expiresAt) => {
      const errors = expectInvalid({ url: 'https://example.com', expiresAt });
      expect(errors.join()).toMatch(/ISO 8601/);
    });

    it.each(['2027-02-30T00:00:00Z', '2027-04-31T00:00:00Z', '2027-02-29T00:00:00Z'])(
      'fails for the impossible calendar date %p',
      (expiresAt) => {
        expect(expectInvalid({ url: 'https://example.com', expiresAt })).toContain(
          'expiresAt is not a real calendar date',
        );
      },
    );

    it('passes for a real leap day', () => {
      expectValid({ url: 'https://example.com', expiresAt: '2028-02-29T00:00:00Z' });
    });
  });

  describe('rule: expiresAt must be in the future', () => {
    it('passes one second from now', () => {
      expectValid({ url: 'https://example.com', expiresAt: '2026-09-29T12:00:01.000Z' });
    });

    it.each([
      ['exactly now', '2026-09-29T12:00:00.000Z'],
      ['one second ago', '2026-09-29T11:59:59.000Z'],
      ['last year', '2025-09-29T12:00:00.000Z'],
    ])('fails for %s', (_name, expiresAt) => {
      expect(expectInvalid({ url: 'https://example.com', expiresAt })).toContain(
        'expiresAt must be in the future',
      );
    });
  });

  describe('rule: expiresAt must be within MAX_EXPIRY_DAYS', () => {
    const month = { ...options, maxExpiryDays: 30 };

    it('passes at exactly the horizon', () => {
      expectValid({ url: 'https://example.com', expiresAt: '2026-10-29T12:00:00.000Z' }, month);
    });

    it('fails one second past the horizon', () => {
      expect(
        expectInvalid({ url: 'https://example.com', expiresAt: '2026-10-29T12:00:01.000Z' }, month),
      ).toContain('expiresAt must be within 30 days from now');
    });
  });

  describe('multiple failures', () => {
    it('reports url and expiresAt problems together', () => {
      const errors = expectInvalid({ url: 'ftp://example.com', expiresAt: 'tomorrow' });
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatch(/http or https/);
      expect(errors[1]).toMatch(/ISO 8601/);
    });
  });
});
