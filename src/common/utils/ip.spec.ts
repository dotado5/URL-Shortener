import { clientIp, hashIp, normalizeIp } from './ip';

describe('normalizeIp', () => {
  it.each([
    ['::ffff:10.1.2.3', '10.1.2.3'],
    ['::FFFF:127.0.0.1', '127.0.0.1'],
    ['10.1.2.3', '10.1.2.3'],
    ['2001:DB8::1', '2001:db8::1'],
    ['::1', '::1'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });

  it('returns "unknown" when there is no address', () => {
    expect(normalizeIp(undefined)).toBe('unknown');
    expect(normalizeIp('')).toBe('unknown');
  });
});

describe('clientIp', () => {
  it('prefers req.ip, which Express has already resolved through trust proxy', () => {
    expect(
      clientIp({ ip: '::ffff:203.0.113.9', socket: { remoteAddress: '10.0.0.1' } } as never),
    ).toBe('203.0.113.9');
  });

  it('falls back to the socket address', () => {
    expect(clientIp({ ip: undefined, socket: { remoteAddress: '10.0.0.1' } } as never)).toBe(
      '10.0.0.1',
    );
  });
});

describe('hashIp', () => {
  const secret = 's'.repeat(32);

  it('is a 64-character hex HMAC that fits the CHAR(64) column', () => {
    expect(hashIp('203.0.113.9', secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same input and secret', () => {
    expect(hashIp('203.0.113.9', secret)).toBe(hashIp('203.0.113.9', secret));
  });

  it('differs per IP and per secret', () => {
    expect(hashIp('203.0.113.9', secret)).not.toBe(hashIp('203.0.113.10', secret));
    expect(hashIp('203.0.113.9', secret)).not.toBe(hashIp('203.0.113.9', 't'.repeat(32)));
  });

  it('never contains the address', () => {
    expect(hashIp('203.0.113.9', secret)).not.toContain('203');
  });
});
