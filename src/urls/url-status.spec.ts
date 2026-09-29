import { urlStatus } from './url-status';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const PAST = new Date('2026-09-29T11:59:59.999Z');
const FUTURE = new Date('2026-09-29T12:00:00.001Z');

describe('urlStatus', () => {
  it('is active with no expiry and no deletion', () => {
    expect(urlStatus({ expiresAt: null, deletedAt: null }, NOW)).toBe('active');
  });

  it('is active when expiry is in the future', () => {
    expect(urlStatus({ expiresAt: FUTURE, deletedAt: null }, NOW)).toBe('active');
  });

  it('is expired when expiry has passed', () => {
    expect(urlStatus({ expiresAt: PAST, deletedAt: null }, NOW)).toBe('expired');
  });

  it('is expired at the exact expiry instant', () => {
    expect(urlStatus({ expiresAt: NOW, deletedAt: null }, NOW)).toBe('expired');
  });

  it('is deleted when deletedAt is set', () => {
    expect(urlStatus({ expiresAt: null, deletedAt: PAST }, NOW)).toBe('deleted');
  });

  it('prefers deleted over expired', () => {
    expect(urlStatus({ expiresAt: PAST, deletedAt: PAST }, NOW)).toBe('deleted');
  });

  it('accepts ISO strings, as records read back from the cache will carry', () => {
    expect(urlStatus({ expiresAt: PAST.toISOString(), deletedAt: null }, NOW)).toBe('expired');
    expect(urlStatus({ expiresAt: FUTURE.toISOString(), deletedAt: null }, NOW)).toBe('active');
    expect(urlStatus({ expiresAt: null, deletedAt: PAST.toISOString() }, NOW)).toBe('deleted');
  });
});
