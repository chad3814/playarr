import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JobDto, SettingsDto } from '@playarr/shared';
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
    covered: [[0, 1]],
    dead: [],
    coveredBytes: 1_000,
  },
};

const SETTINGS: SettingsDto = {
  host: 'news.example.com',
  port: 563,
  security: 'implicit',
  connections: 4,
  username: 'user',
  hasPassword: true,
  passwordFromEnvironment: false,
};

/**
 * The `<video>` element previously had no `error` handler at all: a resumed
 * job on a server with no NNTP provider configured mounted the Player, the
 * stream request failed, and nothing on screen said why. A `MediaError`
 * carries no HTTP status, so the Player asks `GET /settings` to tell
 * "not configured" apart from any other stream failure.
 */
describe('Player: the stream itself fails', () => {
  it('hands off to settings when the server has no provider configured', async () => {
    const onNotConfigured = vi.fn();
    const getSettings = vi.fn(() => Promise.resolve(null));
    render(
      <Player
        job={job}
        onExit={vi.fn()}
        onDeleted={vi.fn()}
        getSettings={getSettings}
        onNotConfigured={onNotConfigured}
      />,
    );

    screen.getByTestId('video').dispatchEvent(new Event('error'));

    await waitFor(() => expect(onNotConfigured).toHaveBeenCalled());
  });

  it('shows a message rather than a dead frame when a configured stream fails', async () => {
    const getSettings = vi.fn(() => Promise.resolve(SETTINGS));
    render(
      <Player
        job={job}
        onExit={vi.fn()}
        onDeleted={vi.fn()}
        getSettings={getSettings}
        onNotConfigured={vi.fn()}
      />,
    );

    screen.getByTestId('video').dispatchEvent(new Event('error'));

    expect(await screen.findByRole('alert')).toBeDefined();
  });
});
