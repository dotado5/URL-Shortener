import { hashDeleteToken, issueDeleteToken, verifyDeleteToken } from './delete-token';

describe('issueDeleteToken', () => {
  it('returns a base64url token carrying 32 bytes of entropy', () => {
    const { token } = issueDeleteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('returns a 64-character hex SHA-256 hash that fits the CHAR(64) column', () => {
    const { token, hash } = issueDeleteToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashDeleteToken(token));
  });

  it('never stores the token itself in the hash', () => {
    const { token, hash } = issueDeleteToken();
    expect(hash).not.toContain(token);
  });

  it('issues unique tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => issueDeleteToken().token));
    expect(tokens.size).toBe(1000);
  });
});

describe('verifyDeleteToken', () => {
  const { token, hash } = issueDeleteToken();

  it('accepts the issued token', () => {
    expect(verifyDeleteToken(token, hash)).toBe(true);
  });

  it('rejects a different valid token', () => {
    expect(verifyDeleteToken(issueDeleteToken().token, hash)).toBe(false);
  });

  it('rejects a token that differs by one character', () => {
    const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    expect(verifyDeleteToken(flipped, hash)).toBe(false);
  });

  it('rejects the hash presented as the token', () => {
    expect(verifyDeleteToken(hash, hash)).toBe(false);
  });

  it.each([undefined, null, '', 123, {}, ['x']])('rejects %p', (presented) => {
    expect(verifyDeleteToken(presented, hash)).toBe(false);
  });

  it('rejects oversized input without hashing megabytes', () => {
    expect(verifyDeleteToken('a'.repeat(10_000), hash)).toBe(false);
  });

  it('rejects when the stored hash is malformed rather than throwing', () => {
    expect(verifyDeleteToken(token, 'short')).toBe(false);
    expect(verifyDeleteToken(token, 'z'.repeat(64))).toBe(false);
  });
});
