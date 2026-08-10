import { describe, expect, it } from 'vitest';
import { SegmentCoverage } from '../src/coverage/coverage.ts';

describe('SegmentCoverage - basic operations', () => {
  it('starts empty', () => {
    const coverage = new SegmentCoverage(10);
    expect(coverage.count).toBe(0);
    expect(coverage.has(0)).toBe(false);
    expect(coverage.runs).toEqual([]);
    expect(coverage.isComplete()).toBe(false);
  });

  it('merges adjacent additions into one run', () => {
    const coverage = new SegmentCoverage(10);
    coverage.add(1);
    coverage.add(2);
    coverage.add(0);
    expect(coverage.runs).toEqual([[0, 3]]);
    expect(coverage.count).toBe(3);
  });

  it('keeps disjoint additions as separate runs, in order', () => {
    const coverage = new SegmentCoverage(10);
    coverage.add(7);
    coverage.add(0);
    expect(coverage.runs).toEqual([
      [0, 1],
      [7, 8],
    ]);
  });
});

describe('SegmentCoverage - run merging', () => {
  it('joins two runs when the gap between them is filled', () => {
    const coverage = new SegmentCoverage(10);
    coverage.addRun(0, 2);
    coverage.addRun(3, 5);
    coverage.add(2);
    expect(coverage.runs).toEqual([[0, 5]]);
  });

  it('is idempotent', () => {
    const coverage = new SegmentCoverage(10);
    coverage.add(4);
    coverage.add(4);
    expect(coverage.count).toBe(1);
    expect(coverage.runs).toEqual([[4, 5]]);
  });

  it('absorbs an overlapping run without double counting', () => {
    const coverage = new SegmentCoverage(10);
    coverage.addRun(2, 6);
    coverage.addRun(4, 8);
    expect(coverage.runs).toEqual([[2, 8]]);
    expect(coverage.count).toBe(6);
  });
});

describe('SegmentCoverage - nextHole', () => {
  it('finds the next hole at or after an index', () => {
    const coverage = new SegmentCoverage(10);
    coverage.addRun(0, 3);
    coverage.addRun(5, 7);
    expect(coverage.nextHole(0)).toBe(3);
    expect(coverage.nextHole(3)).toBe(3);
    expect(coverage.nextHole(5)).toBe(7);
    expect(coverage.nextHole(9)).toBe(9);
  });

  it('returns null when there is no hole at or after an index', () => {
    const coverage = new SegmentCoverage(4);
    coverage.addRun(0, 4);
    expect(coverage.nextHole(0)).toBeNull();
    expect(coverage.isComplete()).toBe(true);
  });
});

describe('SegmentCoverage - nextHoleExcluding', () => {
  it('skips excluded segments when looking for the next hole', () => {
    const coverage = new SegmentCoverage(5);
    const dead = new SegmentCoverage(5);
    coverage.add(0);
    dead.add(1);
    dead.add(2);
    expect(coverage.nextHole(0)).toBe(1);
    expect(coverage.nextHoleExcluding(0, dead)).toBe(3);
  });

  it('returns null when every remaining hole is excluded', () => {
    const coverage = new SegmentCoverage(3);
    const dead = new SegmentCoverage(3);
    coverage.addRun(0, 2);
    dead.add(2);
    expect(coverage.nextHoleExcluding(0, dead)).toBeNull();
  });
});

describe('SegmentCoverage - persistence and validation', () => {
  it('round-trips through its runs', () => {
    const original = new SegmentCoverage(20);
    original.addRun(0, 1);
    original.addRun(5, 9);
    original.addRun(19, 20);
    const restored = new SegmentCoverage(20, original.runs);
    expect(restored.runs).toEqual(original.runs);
    expect(restored.count).toBe(original.count);
  });

  it('rejects an index outside the file', () => {
    const coverage = new SegmentCoverage(3);
    expect(() => coverage.add(3)).toThrow(RangeError);
    expect(() => coverage.add(-1)).toThrow(RangeError);
    expect(() => coverage.addRun(1, 4)).toThrow(RangeError);
  });

  it('treats an empty run as a no-op rather than an error', () => {
    const coverage = new SegmentCoverage(3);
    coverage.addRun(1, 1);
    expect(coverage.runs).toEqual([]);
  });
});
