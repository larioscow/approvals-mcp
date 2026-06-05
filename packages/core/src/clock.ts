export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Deterministic clock for tests. Time only moves when you move it. */
export class FakeClock implements Clock {
  constructor(private t = 0) {}

  now(): number {
    return this.t;
  }

  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }

  set(ms: number): void {
    this.t = ms;
  }
}
