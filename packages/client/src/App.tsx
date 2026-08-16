import { useCallback, useEffect, useState, type JSX } from 'react';
import type { JobDto, SettingsDto, SettingsUpdate } from '@playarr/shared';
import * as api from './api.ts';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { Library } from './views/Library.tsx';
import { Player } from './views/Player.tsx';

interface JobsState {
  readonly jobs: JobDto[];
  readonly refresh: () => void;
}

/** Fetches the job list, reporting a failure through the shared error setter. */
function useJobs(setError: (message: string | null) => void): JobsState {
  const [jobs, setJobs] = useState<JobDto[]>([]);

  const refresh = useCallback(() => {
    void api.listJobs().then(setJobs, (listError: unknown) => setError(String(listError)));
  }, [setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { jobs, refresh };
}

interface SettingsState {
  readonly settings: SettingsDto | null;
  readonly save: (update: SettingsUpdate) => Promise<SettingsDto>;
}

/** Loads the stored provider settings once, and applies whatever is saved back. */
function useSettings(): SettingsState {
  const [settings, setSettings] = useState<SettingsDto | null>(null);

  useEffect(() => {
    void api.getSettings().then(setSettings, () => setSettings(null));
  }, []);

  const save = useCallback(async (update: SettingsUpdate) => {
    const saved = await api.saveSettings(update);
    setSettings(saved);
    return saved;
  }, []);

  return { settings, save };
}

interface PlayingState {
  readonly playing: JobDto | null;
  readonly play: (jobId: string, fileIndex: number) => void;
  readonly exit: () => void;
}

/**
 * Open a job for playback without destroying what is already on disk.
 *
 * `selectFile` is a *selection*, not a resume: the server opens the output
 * file `w+` and persists a selection whose `covered` and `dead` are empty. Ask
 * it for the file a job has already been watching and forty minutes of sparse
 * file is truncated and the record of which bytes were real is gone — and the
 * same is true of every job a container restart brought back `paused` with its
 * coverage intact.
 *
 * A job that already has this file chosen therefore only needs fetching. The
 * `<video>` element's first range request against `GET /stream` calls
 * `JobManager.activate`, which resumes from the persisted coverage; that is
 * the designed resume path and this is the client half of it. A `failed` job
 * is still re-selected, because starting over is the only way out of a
 * failure.
 */
async function openForPlayback(jobId: string, fileIndex: number): Promise<JobDto> {
  const job = await api.getJob(jobId);
  if (job.selection?.fileIndex === fileIndex && job.status !== 'failed') {
    return job;
  }
  return api.selectFile(jobId, fileIndex);
}

/**
 * Owns which job is playing. A `not-configured` failure from the server
 * means there is no provider yet, so it hands off to the settings dialog
 * instead of surfacing a raw error.
 */
function usePlaying(
  refresh: () => void,
  setError: (message: string | null) => void,
  onNotConfigured: () => void,
): PlayingState {
  const [playing, setPlaying] = useState<JobDto | null>(null);

  const play = useCallback(
    (jobId: string, fileIndex: number) => {
      setError(null);
      void openForPlayback(jobId, fileIndex).then(setPlaying, (playError: unknown) => {
        if (playError instanceof api.ApiRequestError && playError.code === 'not-configured') {
          onNotConfigured();
          return;
        }
        setError(playError instanceof Error ? playError.message : String(playError));
      });
    },
    [setError, onNotConfigured],
  );

  const exit = useCallback(() => {
    setPlaying(null);
    refresh();
  }, [refresh]);

  return { playing, play, exit };
}

/** Deletes a job straight from the Library, the only way out for one that can never be played. */
function useDeleteJob(
  refresh: () => void,
  setError: (message: string | null) => void,
): (jobId: string) => void {
  return useCallback(
    (jobId: string) => {
      setError(null);
      void api.deleteJob(jobId).then(refresh, (deleteError: unknown) => {
        setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      });
    },
    [refresh, setError],
  );
}

interface PlayingAreaProps {
  readonly jobs: readonly JobDto[];
  readonly playing: JobDto | null;
  readonly play: (jobId: string, fileIndex: number) => void;
  readonly deleteJob: (jobId: string) => void;
  readonly refresh: () => void;
  readonly exit: () => void;
  readonly onNotConfigured: () => void;
}

/** The Library when nothing is playing, otherwise the Player for the job that is. */
function PlayingArea({
  jobs,
  playing,
  play,
  deleteJob,
  refresh,
  exit,
  onNotConfigured,
}: PlayingAreaProps): JSX.Element {
  if (playing === null) {
    return (
      <Library
        jobs={jobs}
        uploadNzb={api.uploadNzb}
        onPlay={play}
        onDelete={deleteJob}
        onRefresh={refresh}
      />
    );
  }
  return <Player job={playing} onExit={exit} onDeleted={exit} onNotConfigured={onNotConfigured} />;
}

export function App(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { jobs, refresh } = useJobs(setError);
  const { settings, save } = useSettings();
  const onNotConfigured = useCallback(() => setShowSettings(true), []);
  const { playing, play, exit } = usePlaying(refresh, setError, onNotConfigured);
  const deleteJob = useDeleteJob(refresh, setError);

  return (
    <main>
      <nav>
        <h1>playarr</h1>
        <button type="button" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </nav>

      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <PlayingArea
        jobs={jobs}
        playing={playing}
        play={play}
        deleteJob={deleteJob}
        refresh={refresh}
        exit={exit}
        onNotConfigured={onNotConfigured}
      />

      {showSettings && (
        <SettingsDialog
          settings={settings}
          onSave={save}
          onTest={api.testSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </main>
  );
}
