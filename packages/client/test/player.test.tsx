import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobDto } from '@playarr/shared';
import { Player } from '../src/views/Player.tsx';

const job: JobDto = {
  id: 'job1',
  createdAt: '2026-08-10T00:00:00.000Z',
  nzbName: 'release.nzb',
  status: 'ready',
  active: true,
  candidates: [],
  namesUnresolved: false,
  selection: {
    fileIndex: 0,
    name: 'Some.Film.mp4',
    size: 3_400,
    segmentSize: 1_000,
    lastSegmentSize: 400,
    segmentCount: 4,
    covered: [
      [0, 1],
      [3, 4],
    ],
    dead: [],
    coveredBytes: 1_400,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * jsdom does not implement real navigation and logs "Not implemented:
 * navigation" to stderr on any `location.assign` call it cannot intercept.
 * `location.assign` cannot be `vi.spyOn`-ed directly (its property is not
 * configurable on jsdom's `Location`), so the whole object is swapped out
 * for a plain stand-in and restored by the caller.
 */
function stubNavigation(): {
  readonly assign: ReturnType<typeof vi.fn>;
  readonly restore: () => void;
} {
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', {
    value: { ...original, assign },
    writable: true,
    configurable: true,
  });
  return {
    assign,
    restore: () => {
      Object.defineProperty(window, 'location', {
        value: original,
        writable: true,
        configurable: true,
      });
    },
  };
}

describe('Player', () => {
  it('points the video element at the stream endpoint', () => {
    render(<Player job={job} onExit={vi.fn()} onDeleted={vi.fn()} />);
    const video = screen.getByTestId('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/api/jobs/job1/stream');
  });

  it('offers download and delete when playback ends', async () => {
    render(<Player job={job} onExit={vi.fn()} onDeleted={vi.fn()} />);
    const video = screen.getByTestId('video');

    expect(screen.queryByRole('dialog')).toBeNull();
    video.dispatchEvent(new Event('ended'));

    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(screen.getByRole('button', { name: /download/iu })).toBeDefined();
    expect(screen.getByRole('button', { name: /delete/iu })).toBeDefined();
  });
});

describe('Player finished dialog actions', () => {
  it('completes the file before downloading when it still has holes', async () => {
    const complete = vi.fn(() => Promise.resolve({ ...job, status: 'complete' as const }));
    const navigation = stubNavigation();
    try {
      render(<Player job={job} onExit={vi.fn()} onDeleted={vi.fn()} completeJob={complete} />);

      screen.getByTestId('video').dispatchEvent(new Event('ended'));
      await userEvent.click(await screen.findByRole('button', { name: /download/iu }));

      await waitFor(() => expect(complete).toHaveBeenCalledWith('job1'));
      await waitFor(() =>
        expect(navigation.assign).toHaveBeenCalledWith('/api/jobs/job1/download'),
      );
    } finally {
      navigation.restore();
    }
  });

  it('warns about corrupt regions before downloading a file with dead segments', async () => {
    const withDead: JobDto = {
      ...job,
      selection: { ...job.selection!, dead: [2] },
    };
    render(<Player job={withDead} onExit={vi.fn()} onDeleted={vi.fn()} />);

    screen.getByTestId('video').dispatchEvent(new Event('ended'));
    expect(await screen.findByText(/1 article.*could not be fetched/iu)).toBeDefined();
  });

  it('deletes the job and leaves the player', async () => {
    const onDeleted = vi.fn();
    const remove = vi.fn(() => Promise.resolve());
    render(<Player job={job} onExit={vi.fn()} onDeleted={onDeleted} deleteJob={remove} />);

    screen.getByTestId('video').dispatchEvent(new Event('ended'));
    await userEvent.click(await screen.findByRole('button', { name: /delete/iu }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('job1'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });
});
