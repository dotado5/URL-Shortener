export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the breaker. */
  failureThreshold: number;
  /** How long the breaker stays open before letting one probe through. */
  resetMs: number;
  now?: () => number;
  onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

/**
 * Classic three-state breaker, synchronous and I/O-free so it is fully unit-testable.
 *
 * closed    → requests flow; `failureThreshold` consecutive failures open it.
 * open      → requests are refused until `resetMs` has passed.
 * half_open → exactly one probe is allowed. Success closes, failure re-opens for another period.
 *
 * Its job here: once Redis is known to be down or slow, stop paying the command timeout on every
 * redirect and go straight to PostgreSQL.
 */
export class CircuitBreaker {
  private _state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    if (options.failureThreshold < 1) throw new RangeError('failureThreshold must be >= 1');
    if (options.resetMs < 1) throw new RangeError('resetMs must be >= 1');
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    return this._state;
  }

  /** Call before each attempt. `false` means skip the dependency entirely. */
  canRequest(): boolean {
    if (this._state === 'closed') return true;

    if (this._state === 'open') {
      if (this.now() - this.openedAt < this.options.resetMs) return false;
      this.transition('half_open');
    }

    // half_open: one probe at a time.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.probeInFlight = false;
    if (this._state !== 'closed') this.transition('closed');
  }

  recordFailure(): void {
    this.probeInFlight = false;
    if (this._state === 'half_open') {
      this.open();
      return;
    }
    this.failures++;
    if (this._state === 'closed' && this.failures >= this.options.failureThreshold) this.open();
  }

  private open(): void {
    this.openedAt = this.now();
    this.failures = 0;
    this.transition('open');
  }

  private transition(to: BreakerState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this.options.onStateChange?.(from, to);
  }
}
