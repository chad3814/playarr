import type { JSX } from 'react';

export interface LocalCandidate {
  readonly fileIndex: number;
  readonly name: string | null;
  readonly encodedBytes: number;
  readonly segmentCount: number;
  readonly selectable: boolean;
}

interface Props {
  readonly entries: readonly LocalCandidate[];
  readonly onSelect: (fileIndex: number) => void;
  readonly busy: boolean;
}

function mib(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

export function FileList({ entries, onSelect, busy }: Props): JSX.Element {
  return (
    <ul className="file-list">
      {entries.map((entry) => (
        <li key={entry.fileIndex} className={entry.selectable ? '' : 'file-list__item--muted'}>
          <span className="file-list__name">{entry.name ?? '(unnamed)'}</span>
          {/* Encoded size: the only size an NZB knows, 2-4% above the real one. */}
          <span className="file-list__size">{mib(entry.encodedBytes)} encoded</span>
          <span className="file-list__segments">{entry.segmentCount} articles</span>
          <button
            type="button"
            disabled={!entry.selectable || busy}
            onClick={() => onSelect(entry.fileIndex)}
          >
            Play
          </button>
        </li>
      ))}
    </ul>
  );
}
