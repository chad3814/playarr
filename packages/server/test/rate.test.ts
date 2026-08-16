import { describe, expect, it } from 'vitest';
import { RateMeter } from '../src/download/rate.ts';

interface Clock {
  readonly now: () => number;
  advance(ms: number): void;
}

function clock(): Clock {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

describe('RateMeter', () => {
  it('reports nothing until there is a gap to measure', () => {
    const time = clock();
    const meter = new RateMeter(time.now);
    expect(meter.bytesPerSecond).toBe(0);

    meter.record(1_000);
    expect(meter.bytesPerSecond).toBe(0);
  });

  it('reports the instantaneous rate on the second arrival', () => {
    const time = clock();
    const meter = new RateMeter(time.now);

    meter.record(1_000);
    time.advance(500);
    meter.record(1_000);
    expect(meter.bytesPerSecond).toBe(2_000);
  });

  it('smooths towards a new rate rather than jumping to it', () => {
    const time = clock();
    const meter = new RateMeter(time.now);

    meter.record(1_000);
    time.advance(500);
    meter.record(1_000);
    time.advance(1_000);
    meter.record(1_000);

    // 2000 * 0.7 + 1000 * 0.3, not the 1000 the last gap alone suggests.
    expect(meter.bytesPerSecond).toBe(1_700);
  });

  it('ignores a clump that arrives within the same millisecond', () => {
    const time = clock();
    const meter = new RateMeter(time.now);

    meter.record(1_000);
    time.advance(500);
    meter.record(1_000);
    meter.record(1_000);
    expect(meter.bytesPerSecond).toBe(2_000);
  });
});
