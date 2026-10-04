import { BreakerState, CircuitBreaker } from './circuit-breaker';

function make(threshold = 3, resetMs = 1000) {
  let t = 0;
  const transitions: string[] = [];
  const breaker = new CircuitBreaker({
    failureThreshold: threshold,
    resetMs,
    now: () => t,
    onStateChange: (from: BreakerState, to: BreakerState) => transitions.push(`${from}->${to}`),
  });
  return {
    breaker,
    transitions,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fail(b: CircuitBreaker, n: number) {
  for (let i = 0; i < n; i++) {
    expect(b.canRequest()).toBe(true);
    b.recordFailure();
  }
}

describe('CircuitBreaker', () => {
  it('starts closed and lets requests through', () => {
    const { breaker } = make();
    expect(breaker.state).toBe('closed');
    expect(breaker.canRequest()).toBe(true);
  });

  it('stays closed below the failure threshold', () => {
    const { breaker } = make(3);
    fail(breaker, 2);
    expect(breaker.state).toBe('closed');
    expect(breaker.canRequest()).toBe(true);
  });

  it('opens at the threshold and refuses requests', () => {
    const { breaker, transitions } = make(3);
    fail(breaker, 3);
    expect(breaker.state).toBe('open');
    expect(breaker.canRequest()).toBe(false);
    expect(transitions).toEqual(['closed->open']);
  });

  it('counts consecutive failures only: a success resets the count', () => {
    const { breaker } = make(3);
    fail(breaker, 2);
    breaker.recordSuccess();
    fail(breaker, 2);
    expect(breaker.state).toBe('closed');
  });

  it('keeps refusing until resetMs has passed', () => {
    const { breaker, advance } = make(1, 1000);
    fail(breaker, 1);
    advance(999);
    expect(breaker.canRequest()).toBe(false);
  });

  it('lets exactly one probe through after resetMs', () => {
    const { breaker, advance, transitions } = make(1, 1000);
    fail(breaker, 1);
    advance(1000);
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.state).toBe('half_open');
    expect(breaker.canRequest()).toBe(false);
    expect(breaker.canRequest()).toBe(false);
    expect(transitions).toEqual(['closed->open', 'open->half_open']);
  });

  it('closes when the probe succeeds', () => {
    const { breaker, advance, transitions } = make(1, 1000);
    fail(breaker, 1);
    advance(1000);
    breaker.canRequest();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.canRequest()).toBe(true);
    expect(transitions).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
  });

  it('re-opens for a full period when the probe fails', () => {
    const { breaker, advance } = make(3, 1000);
    fail(breaker, 3);
    advance(1000);
    breaker.canRequest();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    advance(999);
    expect(breaker.canRequest()).toBe(false);
    advance(1);
    expect(breaker.canRequest()).toBe(true);
  });

  it('needs the full threshold again after recovering', () => {
    const { breaker, advance } = make(3, 1000);
    fail(breaker, 3);
    advance(1000);
    breaker.canRequest();
    breaker.recordSuccess();
    fail(breaker, 2);
    expect(breaker.state).toBe('closed');
  });

  it('rejects nonsensical options', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0, resetMs: 1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ failureThreshold: 1, resetMs: 0 })).toThrow(RangeError);
  });
});
