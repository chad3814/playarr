import { parseNzb } from '@chad3814/nzb-parser';
import { useCallback, useState, type JSX } from 'react';
import type { JobDto } from '@playarr/shared';
import { Dropzone } from '../components/Dropzone.tsx';
import { FileList, type LocalCandidate } from '../components/FileList.tsx';

interface Props {
  readonly jobs: readonly JobDto[];
  readonly uploadNzb: (file: File) => Promise<JobDto>;
  readonly onPlay: (jobId: string, fileIndex: number) => void;
  readonly onRefresh: () => void;
}

/**
 * Parse in the browser so the file list appears immediately.
 *
 * The parser is the same one the server uses and has no runtime dependencies,
 * so this is the real document, not an approximation of it.
 */
export function localCandidates(xml: string): {
  entries: LocalCandidate[];
  namesUnresolved: boolean;
} {
  const nzb = parseNzb(xml);
  const named = nzb.files.map((file, fileIndex) => ({
    fileIndex,
    name: file.subjectHints.name,
    encodedBytes: file.totalEncodedBytes,
    segmentCount: file.segments.length,
    playable: file.subjectHints.name?.toLowerCase().endsWith('.mp4') === true,
  }));

  const namesUnresolved = !named.some((entry) => entry.playable);
  return {
    namesUnresolved,
    entries: named.map(({ playable, ...rest }) => ({
      ...rest,
      selectable: namesUnresolved || playable,
    })),
  };
}

interface AcceptState {
  readonly entries: LocalCandidate[] | null;
  readonly unresolved: boolean;
  readonly error: string | null;
  readonly setError: (message: string | null) => void;
  readonly pending: Promise<JobDto> | null;
  readonly accept: (file: File) => Promise<void>;
}

/** Parses a dropped file locally, then kicks off the upload in the background. */
function useAccept(uploadNzb: Props['uploadNzb']): AcceptState {
  const [entries, setEntries] = useState<LocalCandidate[] | null>(null);
  const [unresolved, setUnresolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Promise<JobDto> | null>(null);

  const accept = useCallback(
    async (file: File) => {
      setError(null);
      try {
        // Inside the try, not before it: the call site discards this promise
        // with `void`, so a file that cannot be read -- a directory dropped on
        // the zone, a file revoked between the drop and the read -- would be
        // an unhandled rejection and nothing on screen, rather than the error
        // line every other failure here produces.
        const parsed = localCandidates(await file.text());
        setEntries(parsed.entries);
        setUnresolved(parsed.namesUnresolved);
      } catch (parseError) {
        setEntries(null);
        setError(parseError instanceof Error ? parseError.message : String(parseError));
        // Never upload something the parser already rejected.
        return;
      }
      setPending(uploadNzb(file));
    },
    [uploadNzb],
  );

  return { entries, unresolved, error, setError, pending, accept };
}

interface PlayState {
  readonly busy: boolean;
  readonly play: (fileIndex: number) => Promise<void>;
}

/** Waits for the pending upload, then hands the chosen file off to the caller. */
function usePlay(
  onPlay: Props['onPlay'],
  onRefresh: Props['onRefresh'],
  pending: Promise<JobDto> | null,
  setError: (message: string | null) => void,
): PlayState {
  const [busy, setBusy] = useState(false);

  const play = useCallback(
    async (fileIndex: number) => {
      if (pending === null) {
        return;
      }
      setBusy(true);
      try {
        const job = await pending;
        onRefresh();
        onPlay(job.id, fileIndex);
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
      } finally {
        setBusy(false);
      }
    },
    [onPlay, onRefresh, pending, setError],
  );

  return { busy, play };
}

interface LibraryState {
  readonly entries: LocalCandidate[] | null;
  readonly unresolved: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly accept: (file: File) => Promise<void>;
  readonly play: (fileIndex: number) => Promise<void>;
}

/** Owns the parse-then-upload-then-select flow so `Library` stays a plain view. */
function useLibrary(
  uploadNzb: Props['uploadNzb'],
  onPlay: Props['onPlay'],
  onRefresh: Props['onRefresh'],
): LibraryState {
  const { entries, unresolved, error, setError, pending, accept } = useAccept(uploadNzb);
  const { busy, play } = usePlay(onPlay, onRefresh, pending, setError);

  return { entries, unresolved, error, busy, accept, play };
}

interface JobButtonProps {
  readonly job: JobDto;
  readonly onPlay: Props['onPlay'];
}

/**
 * A job with no selection has nothing to play, and file 0 is not a guess worth
 * making: it is whichever file happened to come first in the NZB, and choosing
 * it is a destructive act on the server — the output file is opened `w+` and
 * the persisted coverage reset. The only way to choose a file is to drop the
 * NZB again and pick one from the list, so the button is offered dead.
 */
function JobButton({ job, onPlay }: JobButtonProps): JSX.Element {
  const selection = job.selection;
  if (selection === undefined) {
    return (
      <button type="button" disabled>
        {job.nzbName}
      </button>
    );
  }
  return (
    <button type="button" onClick={() => onPlay(job.id, selection.fileIndex)}>
      {selection.name}
    </button>
  );
}

function JobList({ jobs, onPlay }: Pick<Props, 'jobs' | 'onPlay'>): JSX.Element | null {
  if (jobs.length === 0) {
    return null;
  }
  return (
    <>
      <h2>Jobs</h2>
      <ul className="job-list">
        {jobs.map((job) => (
          <li key={job.id}>
            <JobButton job={job} onPlay={onPlay} />
            <span>{job.status}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Library({ jobs, uploadNzb, onPlay, onRefresh }: Props): JSX.Element {
  const { entries, unresolved, error, busy, accept, play } = useLibrary(
    uploadNzb,
    onPlay,
    onRefresh,
  );

  return (
    <section className="library">
      <Dropzone onFile={(file) => void accept(file)} />

      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {unresolved && entries !== null && (
        <p className="notice">
          The filenames in this NZB could not be determined without fetching, so every file is
          offered. Choosing one checks whether it is really an MP4.
        </p>
      )}

      {entries !== null && (
        <FileList entries={entries} onSelect={(index) => void play(index)} busy={busy} />
      )}

      <JobList jobs={jobs} onPlay={onPlay} />
    </section>
  );
}
