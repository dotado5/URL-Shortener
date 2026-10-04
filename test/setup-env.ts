/**
 * Baseline environment for e2e tests. CI and the compose `test` profile expose PostgreSQL on 55433
 * and Redis on 56380: unusual ports, so a run can never land on the development databases or on
 * another project's containers that happen to use a common port.
 * Any variable already set in the process environment wins.
 */
process.env.NODE_ENV = 'test';
process.env.BASE_URL ??= 'http://localhost:3000';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:55433/url_shortener_test';
process.env.REDIS_URL ??= 'redis://localhost:56380';
process.env.LOG_LEVEL ??= 'silent';
process.env.IP_HASH_SECRET ??= 'test-secret-test-secret-test-secret-00';
// Generous limits so suites that create many URLs exercise the limiter without tripping it.
// test/rate-limit.e2e-spec.ts boots its own app with small limits.
process.env.RATE_LIMIT_CREATE_MAX ??= '100000';
process.env.RATE_LIMIT_DELETE_MAX ??= '100000';
process.env.RATE_LIMIT_INFO_MAX ??= '100000';
