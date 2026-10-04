import { EnvValidationError, validateEnv } from './env.schema';

const minimal = {
  BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/url_shortener',
  REDIS_URL: 'redis://localhost:6379',
};

describe('validateEnv', () => {
  it('applies defaults when only required variables are set', () => {
    const env = validateEnv(minimal);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SHORT_CODE_LENGTH).toBe(7);
    expect(env.CACHE_ENABLED).toBe(true);
    expect(env.RATE_LIMIT_FAIL_MODE).toBe('closed');
    expect(env.CLEANUP_CRON).toBe('*/15 * * * *');
  });

  it('coerces numeric and boolean strings', () => {
    const env = validateEnv({
      ...minimal,
      PORT: '8080',
      CACHE_ENABLED: 'false',
      METRICS_ENABLED: '0',
    });
    expect(env.PORT).toBe(8080);
    expect(env.CACHE_ENABLED).toBe(false);
    expect(env.METRICS_ENABLED).toBe(false);
  });

  it('rejects a missing DATABASE_URL with a readable message', () => {
    const { DATABASE_URL: _omit, ...rest } = minimal;
    expect(() => validateEnv(rest)).toThrow(EnvValidationError);
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not a postgres URL', () => {
    expect(() => validateEnv({ ...minimal, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a REDIS_URL that is not a redis URL', () => {
    expect(() => validateEnv({ ...minimal, REDIS_URL: 'http://localhost' })).toThrow(/REDIS_URL/);
  });

  it('rejects out-of-range numbers', () => {
    expect(() => validateEnv({ ...minimal, SHORT_CODE_LENGTH: '3' })).toThrow(/SHORT_CODE_LENGTH/);
    expect(() => validateEnv({ ...minimal, PORT: '70000' })).toThrow(/PORT/);
  });

  it.each(['bogus', '61 * * * *', '0 25 * * *', '* * * * * * *', '*/0 * * * *'])(
    'rejects the invalid CLEANUP_CRON %p at boot',
    (cron) => {
      expect(() => validateEnv({ ...minimal, CLEANUP_CRON: cron })).toThrow(/CLEANUP_CRON/);
    },
  );

  it.each(['*/15 * * * *', '* * * * *', '0 3 * * *'])('accepts the cron %p', (cron) => {
    expect(validateEnv({ ...minimal, CLEANUP_CRON: cron }).CLEANUP_CRON).toBe(cron);
  });

  it('requires the shutdown timeout to leave room for an in-flight job', () => {
    expect(() =>
      validateEnv({ ...minimal, JOB_TIMEOUT_MS: '10000', SHUTDOWN_TIMEOUT_MS: '10000' }),
    ).toThrow(/SHUTDOWN_TIMEOUT_MS/);
    expect(
      validateEnv({ ...minimal, JOB_TIMEOUT_MS: '10000', SHUTDOWN_TIMEOUT_MS: '13000' })
        .SHUTDOWN_TIMEOUT_MS,
    ).toBe(13000);
  });

  it('defaults are consistent with each other', () => {
    const env = validateEnv(minimal);
    expect(env.SHUTDOWN_TIMEOUT_MS).toBeGreaterThanOrEqual(env.JOB_TIMEOUT_MS + 3000);
    expect(env.SHUTDOWN_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it('rejects an unknown RATE_LIMIT_FAIL_MODE', () => {
    expect(() => validateEnv({ ...minimal, RATE_LIMIT_FAIL_MODE: 'maybe' })).toThrow(
      /RATE_LIMIT_FAIL_MODE/,
    );
  });

  describe('in production', () => {
    it('requires a strong IP_HASH_SECRET', () => {
      expect(() =>
        validateEnv({ ...minimal, NODE_ENV: 'production', IP_HASH_SECRET: 'short' }),
      ).toThrow(/IP_HASH_SECRET/);
    });

    it('requires the rate limiter to fail closed', () => {
      expect(() =>
        validateEnv({
          ...minimal,
          NODE_ENV: 'production',
          IP_HASH_SECRET: 'x'.repeat(32),
          RATE_LIMIT_FAIL_MODE: 'open',
        }),
      ).toThrow(/RATE_LIMIT_FAIL_MODE/);
    });

    it('accepts a valid production configuration', () => {
      const env = validateEnv({
        ...minimal,
        NODE_ENV: 'production',
        IP_HASH_SECRET: 'x'.repeat(32),
      });
      expect(env.NODE_ENV).toBe('production');
    });
  });
});
