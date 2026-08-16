import { useCallback, useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type { JobDto, JobStatus, ProgressEvent, SegmentRun } from '@playarr/shared';
import * as defaultApi from '../api.ts';
import { isProgressEvent } from '../api.ts';
import { CoverageBar } from '../components/CoverageBar.tsx';
import { useEventSource } from '../hooks/useEventSource.ts';

interface Props {
  readonly job: JobDto;
  readonly onExit: () => void;
  readonly onDeleted: () => void;
  /** Injected in tests. */
  readonly completeJob?: (id: string) => Promise<JobDto>;
  readonly deleteJob?: (id: string) => Promise<void>;
}

function mibPerSecond(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1_048_576).toFixed(2)} MiB/s`;
}

/**
 * True once the video element fires `ended`. A native listener, not React's
 * `onEnded` prop, because `ended` does not bubble and React 19 delegates
 * events from the root container.
 */
function useEnded(video: RefObject<HTMLVideoElement | null>): {
  readonly finished: boolean;
  readonly dismiss: () => void;
} {
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const element = video.current;
    if (element === null) {
      return;
    }
    const onEnded = (): void => setFinished(true);
    element.addEventListener('ended', onEnded);
    return () => element.removeEventListener('ended', onEnded);
  }, [video]);

  const dismiss = useCallback(() => setFinished(false), []);
  return { finished, dismiss };
}

interface JobActions {
  readonly working: string | null;
  readonly error: string | null;
  readonly download: () => void;
  readonly remove: () => void;
}

/** Owns the completing-then-downloading and deleting flows, and their shared busy/error state. */
function useJobActions(
  jobId: string,
  onDeleted: () => void,
  completeJob: (id: string) => Promise<JobDto>,
  deleteJob: (id: string) => Promise<void>,
): JobActions {
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setError(null);
    setWorking(label);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setWorking(null);
    }
  }, []);

  const download = useCallback(() => {
    void run('Filling the gaps left by seeking…', async () => {
      await completeJob(jobId);
      // A plain navigation is the simplest correct way to move a
      // multi-gigabyte file out of the container: the browser streams it
      // straight to disk.
      window.location.assign(`/api/jobs/${jobId}/download`);
    });
  }, [run, completeJob, jobId]);

  const remove = useCallback(() => {
    void run('Deleting…', async () => {
      await deleteJob(jobId);
      onDeleted();
    });
  }, [run, deleteJob, jobId, onDeleted]);

  return { working, error, download, remove };
}

interface PlaybackState {
  readonly progress: ProgressEvent | null;
  readonly covered: readonly SegmentRun[];
  readonly dead: readonly number[];
  readonly segmentCount: number;
}

/** Merges the live SSE progress frame over the job's last-known selection. */
function usePlaybackState(job: JobDto): PlaybackState {
  const progress = useEventSource<ProgressEvent>(`/api/jobs/${job.id}/events`, isProgressEvent);
  const selection = job.selection;
  return {
    progress,
    covered: progress?.covered ?? selection?.covered ?? [],
    dead: progress?.dead ?? selection?.dead ?? [],
    segmentCount: selection?.segmentCount ?? 0,
  };
}

interface StatusLineProps {
  readonly progress: ProgressEvent | null;
  readonly status: JobStatus;
  readonly deadCount: number;
  readonly error: string | null;
}

function StatusLine({ progress, status, deadCount, error }: StatusLineProps): JSX.Element {
  return (
    <>
      <p className="stats">
        {mibPerSecond(progress?.bytesPerSecond ?? 0)} · {progress?.status ?? status}
        {deadCount > 0 && ` · ${deadCount} corrupt region${deadCount === 1 ? '' : 's'}`}
      </p>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}

interface FinishedDialogProps {
  readonly deadCount: number;
  readonly working: string | null;
  readonly onDownload: () => void;
  readonly onDelete: () => void;
  readonly onKeepWatching: () => void;
}

function FinishedDialog({
  deadCount,
  working,
  onDownload,
  onDelete,
  onKeepWatching,
}: FinishedDialogProps): JSX.Element {
  return (
    <div role="dialog" aria-label="Finished" className="dialog">
      <p>Finished. Keep the file or throw it away?</p>
      {deadCount > 0 && (
        <p className="notice">
          {deadCount} article{deadCount === 1 ? '' : 's'} could not be fetched, so parts of this
          file are corrupt and cannot be repaired.
        </p>
      )}
      {working !== null && <p>{working}</p>}
      <button type="button" disabled={working !== null} onClick={onDownload}>
        Download
      </button>
      <button type="button" disabled={working !== null} onClick={onDelete}>
        Delete
      </button>
      <button type="button" disabled={working !== null} onClick={onKeepWatching}>
        Keep watching
      </button>
    </div>
  );
}

export function Player({
  job,
  onExit,
  onDeleted,
  completeJob = defaultApi.completeJob,
  deleteJob = defaultApi.deleteJob,
}: Props): JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  const { finished, dismiss } = useEnded(video);
  const { working, error, download, remove } = useJobActions(
    job.id,
    onDeleted,
    completeJob,
    deleteJob,
  );
  const { progress, covered, dead, segmentCount } = usePlaybackState(job);

  return (
    <section className="player">
      <header>
        <button type="button" onClick={onExit}>
          Back
        </button>
        <h1>{job.selection?.name ?? job.nzbName}</h1>
      </header>

      <video ref={video} data-testid="video" controls src={`/api/jobs/${job.id}/stream`} />

      <CoverageBar covered={covered} dead={dead} segmentCount={segmentCount} />

      <StatusLine progress={progress} status={job.status} deadCount={dead.length} error={error} />

      {finished && (
        <FinishedDialog
          deadCount={dead.length}
          working={working}
          onDownload={download}
          onDelete={remove}
          onKeepWatching={dismiss}
        />
      )}
    </section>
  );
}
