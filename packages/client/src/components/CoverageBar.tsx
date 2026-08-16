import type { JSX } from 'react';
import type { SegmentRun } from '@playarr/shared';

interface Props {
  readonly covered: readonly SegmentRun[];
  readonly dead: readonly number[];
  readonly segmentCount: number;
}

export function CoverageBar({ covered, dead, segmentCount }: Props): JSX.Element {
  const total = segmentCount > 0 ? segmentCount : 1;
  const coveredCount = covered.reduce((sum, [start, end]) => sum + (end - start), 0);
  const percent = segmentCount > 0 ? Math.round((coveredCount / segmentCount) * 100) : 0;

  return (
    <div
      className="coverage"
      role="progressbar"
      aria-label="Downloaded"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      {covered.map(([start, end], index) => (
        <span
          key={`covered-${start}`}
          data-testid={`covered-${index}`}
          className="coverage__run"
          style={{ left: `${(start / total) * 100}%`, width: `${((end - start) / total) * 100}%` }}
        />
      ))}
      {dead.map((index) => (
        <span
          key={`dead-${index}`}
          data-testid={`dead-${index}`}
          className="coverage__dead"
          style={{ left: `${(index / total) * 100}%`, width: `${(1 / total) * 100}%` }}
        />
      ))}
    </div>
  );
}
