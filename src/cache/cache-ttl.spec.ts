import { cacheTtlSeconds } from './cache-ttl';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('cacheTtlSeconds', () => {
  it('uses the default for URLs that never expire', () => {
    expect(cacheTtlSeconds({ expiresAt: null, deletedAt: null }, 3600, NOW)).toBe(3600);
  });

  it('uses the default when expiry is further away than the default', () => {
    expect(cacheTtlSeconds({ expiresAt: at(2 * 3600_000), deletedAt: null }, 3600, NOW)).toBe(3600);
  });

  it('caps the TTL at the time left before expiry', () => {
    expect(cacheTtlSeconds({ expiresAt: at(90_000), deletedAt: null }, 3600, NOW)).toBe(90);
  });

  it('rounds down so the entry never outlives the URL', () => {
    expect(cacheTtlSeconds({ expiresAt: at(90_999), deletedAt: null }, 3600, NOW)).toBe(90);
  });

  it('does not cache with under a second left', () => {
    expect(cacheTtlSeconds({ expiresAt: at(999), deletedAt: null }, 3600, NOW)).toBeNull();
  });

  it.each([
    ['exactly now', 0],
    ['already expired', -1000],
  ])('does not cache when %s', (_name, offset) => {
    expect(cacheTtlSeconds({ expiresAt: at(offset), deletedAt: null }, 3600, NOW)).toBeNull();
  });

  it('does not cache deleted URLs', () => {
    expect(cacheTtlSeconds({ expiresAt: null, deletedAt: at(-1) }, 3600, NOW)).toBeNull();
  });

  it('accepts ISO strings as stored in the cache', () => {
    expect(
      cacheTtlSeconds({ expiresAt: at(60_000).toISOString(), deletedAt: null }, 3600, NOW),
    ).toBe(60);
  });
});
