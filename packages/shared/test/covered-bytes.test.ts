import { describe, expect, it } from 'vitest';
import { coveredBytes, type SegmentGeometryDto } from '../src/index.ts';

// Four segments: three full, one short tail. Total 3400.
const geometry: SegmentGeometryDto = {
  segmentSize: 1_000,
  lastSegmentSize: 400,
  segmentCount: 4,
};

describe('coveredBytes', () => {
  it('is zero for no coverage', () => {
    expect(coveredBytes([], geometry)).toBe(0);
  });

  it('counts whole segments at full size', () => {
    expect(coveredBytes([[0, 2]], geometry)).toBe(2_000);
  });

  it('counts the last segment at its real, shorter size', () => {
    expect(coveredBytes([[3, 4]], geometry)).toBe(400);
  });

  it('sums disjoint runs', () => {
    expect(
      coveredBytes(
        [
          [0, 1],
          [3, 4],
        ],
        geometry,
      ),
    ).toBe(1_400);
  });

  it('totals the whole file exactly', () => {
    expect(coveredBytes([[0, 4]], geometry)).toBe(3_400);
  });

  it('handles a single-segment file, where the only segment is the last', () => {
    expect(
      coveredBytes([[0, 1]], { segmentSize: 500, lastSegmentSize: 500, segmentCount: 1 }),
    ).toBe(500);
  });

  it('clamps a run that runs past the end rather than inventing bytes', () => {
    expect(coveredBytes([[2, 99]], geometry)).toBe(1_400);
  });
});
