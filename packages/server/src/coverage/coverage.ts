import type { SegmentRun } from '@playarr/shared';

/**
 * A set of segment indices, stored as sorted, disjoint, non-adjacent
 * half-open runs.
 *
 * Coverage is tracked in segments rather than bytes because a segment is the
 * unit a fetch actually delivers: anchors are always segment-aligned, so every
 * article that lands covers exactly one index. Byte-range arithmetic would
 * admit partial segments, which nothing can produce.
 */
export class SegmentCoverage {
  readonly #segmentCount: number;
  #runs: SegmentRun[];

  constructor(segmentCount: number, runs: readonly SegmentRun[] = []) {
    if (!Number.isInteger(segmentCount) || segmentCount < 0) {
      throw new RangeError(`segmentCount must be a non-negative integer: ${segmentCount}`);
    }
    this.#segmentCount = segmentCount;
    this.#runs = [];
    for (const [start, end] of runs) {
      this.addRun(start, end);
    }
  }

  get segmentCount(): number {
    return this.#segmentCount;
  }

  /** Sorted, disjoint, non-adjacent. Safe to persist verbatim. */
  get runs(): SegmentRun[] {
    return this.#runs.map(([start, end]) => [start, end] as SegmentRun);
  }

  get count(): number {
    return this.#runs.reduce((total, [start, end]) => total + (end - start), 0);
  }

  has(index: number): boolean {
    return this.#runs.some(([start, end]) => index >= start && index < end);
  }

  add(index: number): void {
    this.addRun(index, index + 1);
  }

  addRun(start: number, end: number): void {
    if (end === start) {
      return;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
      throw new RangeError(`not a valid run: [${start}, ${end})`);
    }
    if (start < 0 || end > this.#segmentCount) {
      throw new RangeError(`run [${start}, ${end}) is outside [0, ${this.#segmentCount})`);
    }

    const merged: SegmentRun[] = [];
    let lo = start;
    let hi = end;

    for (const run of this.#runs) {
      const [runStart, runEnd] = run;
      if (runEnd < lo) {
        // entirely before, and not touching
        merged.push(run);
      } else if (runStart > hi) {
        // entirely after, and not touching
        merged.push(run);
      } else {
        // overlaps or abuts: absorb it
        lo = Math.min(lo, runStart);
        hi = Math.max(hi, runEnd);
      }
    }

    merged.push([lo, hi]);
    merged.sort((a, b) => a[0] - b[0]);
    this.#runs = merged;
  }

  /** First uncovered index at or after `from`, or null if there is none. */
  nextHole(from: number): number | null {
    let candidate = Math.max(0, from);
    for (const [start, end] of this.#runs) {
      if (candidate < start) {
        break;
      }
      if (candidate < end) {
        candidate = end;
      }
    }
    return candidate < this.#segmentCount ? candidate : null;
  }

  /**
   * First index at or after `from` that is neither covered nor in `excluded`.
   *
   * Used by the fetcher to skip segments the provider no longer has: a dead
   * segment is not covered and never will be, so a plain `nextHole` would
   * return it forever.
   */
  nextHoleExcluding(from: number, excluded: SegmentCoverage): number | null {
    let candidate = this.nextHole(from);
    while (candidate !== null && excluded.has(candidate)) {
      candidate = this.nextHole(candidate + 1);
    }
    return candidate;
  }

  isComplete(): boolean {
    return this.count === this.#segmentCount;
  }
}
