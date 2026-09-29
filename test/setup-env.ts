/**
 * Baseline environment for e2e tests. CI and the compose `test` profile expose PostgreSQL on 5433
 * and Redis on 6380 so tests never touch the development databases.
 * Any variable already set in the process environment wins.
 */
process.env.NODE_ENV = 'test';
process.env.BASE_URL ??= 'http://localhost:3000';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5433/url_shortener_test';
process.env.REDIS_URL ??= 'redis://localhost:6380';
process.env.LOG_LEVEL ??= 'silent';
process.env.IP_HASH_SECRET ??= 'test-secret-test-secret-test-secret-00';
