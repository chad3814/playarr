import { useCallback, useEffect, useState, type JSX } from 'react';
import type { JobDto } from '@playarr/shared';
import { listJobs, selectFile, uploadNzb } from './api.ts';
import { Library } from './views/Library.tsx';

interface AppState {
  readonly jobs: readonly JobDto[];
  readonly playingJobId: string | null;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly play: (jobId: string, fileIndex: number) => void;
}

/** Fetches the job list and turns a chosen file into a playing stream. */
function useJobs(): AppState {
  const [jobs, setJobs] = useState<readonly JobDto[]>([]);
  const [playingJobId, setPlayingJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listJobs()
      .then(setJobs)
      .catch((refreshError: unknown) => {
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const play = useCallback(
    (jobId: string, fileIndex: number) => {
      setError(null);
      selectFile(jobId, fileIndex)
        .then(() => {
          setPlayingJobId(jobId);
          refresh();
        })
        .catch((selectError: unknown) => {
          setError(selectError instanceof Error ? selectError.message : String(selectError));
        });
    },
    [refresh],
  );

  return { jobs, playingJobId, error, refresh, play };
}

export function App(): JSX.Element {
  const { jobs, playingJobId, error, refresh, play } = useJobs();

  return (
    <main className="app">
      <h1>playarr</h1>

      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <Library jobs={jobs} uploadNzb={uploadNzb} onPlay={play} onRefresh={refresh} />

      {playingJobId !== null && (
        <video
          key={playingJobId}
          className="player"
          controls
          src={`/api/jobs/${playingJobId}/stream`}
        />
      )}
    </main>
  );
}
