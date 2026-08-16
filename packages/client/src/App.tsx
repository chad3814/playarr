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
      void api.selectFile(jobId, fileIndex).then(setPlaying, (selectError: unknown) => {
        if (selectError instanceof api.ApiRequestError && selectError.code === 'not-configured') {
          onNotConfigured();
          return;
        }
        setError(selectError instanceof Error ? selectError.message : String(selectError));
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

export function App(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { jobs, refresh } = useJobs(setError);
  const { settings, save } = useSettings();
  const { playing, play, exit } = usePlaying(refresh, setError, () => setShowSettings(true));

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

      {playing === null ? (
        <Library jobs={jobs} uploadNzb={api.uploadNzb} onPlay={play} onRefresh={refresh} />
      ) : (
        <Player job={playing} onExit={exit} onDeleted={exit} />
      )}

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
