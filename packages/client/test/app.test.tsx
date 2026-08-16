import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobDto } from '@playarr/shared';
import * as api from '../src/api.ts';
import { App } from '../src/App.tsx';

// Only the four calls App makes on mount and on play are replaced; the rest of
// the module (ApiRequestError, isProgressEvent, the Player's own defaults) has
// to stay real, because App's error branch narrows on the real class and the
// Player narrows SSE frames with the real guard.
vi.mock('../src/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.ts')>();
  return {
    ...actual,
    listJobs: vi.fn(),
    getJob: vi.fn(),
    selectFile: vi.fn(),
    getSettings: vi.fn(),
  };
});

/** A job the user has already watched: paused, with real coverage on disk. */
const WATCHED: JobDto = {
  id: 'job1',
  createdAt: '2026-08-10T00:00:00.000Z',
  nzbName: 'release.nzb',
  status: 'paused',
  active: false,
  candidates: [],
  namesUnresolved: false,
  selection: {
    fileIndex: 0,
    name: 'Some.Film.mp4',
    size: 4_000,
    segmentSize: 1_000,
    lastSegmentSize: 1_000,
    segmentCount: 4,
    covered: [[0, 3]],
    dead: [],
    coveredBytes: 3_000,
  },
};

beforeEach(() => {
  vi.mocked(api.getSettings).mockResolvedValue(null);
  vi.mocked(api.listJobs).mockResolvedValue([WATCHED]);
  vi.mocked(api.getJob).mockResolvedValue(WATCHED);
  vi.mocked(api.selectFile).mockResolvedValue(WATCHED);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App - reopening a job that already has its file selected', () => {
  it('resumes it rather than re-selecting, which would truncate the file', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Some.Film.mp4' }));

    // The Player is mounted, so play() has resolved: its first range request
    // against /stream is what activates the job from its persisted coverage.
    expect(await screen.findByRole('button', { name: 'Back' })).toBeDefined();
    expect(api.getJob).toHaveBeenCalledWith('job1');
    expect(api.selectFile).not.toHaveBeenCalled();
  });
});

describe('App - reopening a job whose selection has gone', () => {
  it('selects the file, because the list it was clicked from was stale', async () => {
    const { selection: _gone, ...unselected } = WATCHED;
    vi.mocked(api.getJob).mockResolvedValue({ ...unselected, status: 'uploaded' });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Some.Film.mp4' }));

    expect(await screen.findByRole('button', { name: 'Back' })).toBeDefined();
    expect(api.selectFile).toHaveBeenCalledWith('job1', 0);
  });
});
