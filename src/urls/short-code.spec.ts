import {
  RESERVED_CODES,
  SHORT_CODE_ALPHABET,
  generateShortCode,
  isReservedCode,
  isWellFormedShortCode,
} from './short-code';

/** Deterministic random source that spells out the given words, then falls back to index 0. */
function spelling(...words: string[]): (max: number) => number {
  const indexes = words
    .join('')
    .split('')
    .map((ch) => SHORT_CODE_ALPHABET.indexOf(ch));
  let i = 0;
  return () => (i < indexes.length ? indexes[i++] : 0);
}

describe('SHORT_CODE_ALPHABET', () => {
  it('is Base62 with no duplicates', () => {
    expect(SHORT_CODE_ALPHABET).toHaveLength(62);
    expect(new Set(SHORT_CODE_ALPHABET).size).toBe(62);
    expect(SHORT_CODE_ALPHABET).toMatch(/^[a-zA-Z0-9]+$/);
  });
});

describe('generateShortCode', () => {
  it('generates a code of the requested length from the alphabet', () => {
    for (const length of [6, 7, 12]) {
      const code = generateShortCode(length);
      expect(code).toHaveLength(length);
      expect(code).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  it('produces no duplicates across a large sample', () => {
    const codes = new Set(Array.from({ length: 5000 }, () => generateShortCode(7)));
    expect(codes.size).toBe(5000);
  });

  it('uses every character class', () => {
    const sample = Array.from({ length: 200 }, () => generateShortCode(7)).join('');
    expect(sample).toMatch(/[a-z]/);
    expect(sample).toMatch(/[A-Z]/);
    expect(sample).toMatch(/[0-9]/);
  });

  it.each([5, 13, 0, -1, 6.5, Number.NaN])('rejects length %p', (length) => {
    expect(() => generateShortCode(length)).toThrow(RangeError);
  });

  it('re-rolls when the random source spells a reserved word', () => {
    expect(generateShortCode(6, spelling('health', 'abc123'))).toBe('abc123');
  });

  it('re-rolls reserved words regardless of case', () => {
    expect(generateShortCode(6, spelling('HeAlTh', 'xyz789'))).toBe('xyz789');
    expect(generateShortCode(7, spelling('METRICS', 'Qrs4567'))).toBe('Qrs4567');
  });

  it('gives up instead of looping forever when every roll is reserved', () => {
    const alwaysHealth = (() => {
      const idx = 'health'.split('').map((c) => SHORT_CODE_ALPHABET.indexOf(c));
      let i = 0;
      return () => idx[i++ % idx.length];
    })();
    expect(() => generateShortCode(6, alwaysHealth)).toThrow(/non-reserved/);
  });
});

describe('isReservedCode', () => {
  it.each([...RESERVED_CODES])('treats %p as reserved', (word) => {
    expect(isReservedCode(word)).toBe(true);
    expect(isReservedCode(word.toUpperCase())).toBe(true);
  });

  it('covers every root path the application serves', () => {
    for (const word of ['api', 'health', 'metrics', 'docs', 'favicon.ico', 'robots.txt']) {
      expect(RESERVED_CODES.has(word)).toBe(true);
    }
  });

  it('does not flag ordinary codes', () => {
    expect(isReservedCode('a8K2xPq')).toBe(false);
  });
});

describe('isWellFormedShortCode', () => {
  it.each(['a8K2xPq', 'abcdef', 'ABCDEF123456', '000000'])('accepts %p', (code) => {
    expect(isWellFormedShortCode(code)).toBe(true);
  });

  it.each([
    ['too short', 'abc12'],
    ['too long', 'a'.repeat(13)],
    ['dot', 'favicon.ico'],
    ['dash', 'abc-123'],
    ['underscore', 'abc_123'],
    ['slash', 'abc/123'],
    ['space', 'abc 123'],
    ['unicode', 'abcdé12'],
    ['empty', ''],
    ['reserved', 'health'],
    ['reserved upper', 'METRICS'],
  ])('rejects %s', (_name, code) => {
    expect(isWellFormedShortCode(code)).toBe(false);
  });

  it.each([undefined, null, 1234567, {}, []])('rejects non-string %p', (value) => {
    expect(isWellFormedShortCode(value)).toBe(false);
  });
});
