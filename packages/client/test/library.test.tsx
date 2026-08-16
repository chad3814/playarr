import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobDto } from '@playarr/shared';
import { Library } from '../src/views/Library.tsx';

const NZB = `<?xml version="1.0" encoding="iso-8859-1" ?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="p@example.com" date="1700000000" subject="[1/2] - &quot;Some.Film.mp4&quot; yEnc (1/2)">
    <groups><group>alt.binaries.test</group></groups>
    <segments>
      <segment bytes="500" number="1">a@example.com</segment>
      <segment bytes="500" number="2">b@example.com</segment>
    </segments>
  </file>
  <file poster="p@example.com" date="1700000000" subject="[2/2] - &quot;Some.Film.nfo&quot; yEnc (1/1)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="100" number="1">c@example.com</segment></segments>
  </file>
</nzb>`;

const JOB: JobDto = {
  id: 'job1',
  createdAt: '2026-08-10T00:00:00.000Z',
  nzbName: 'release.nzb',
  status: 'uploaded',
  active: false,
  candidates: [],
  namesUnresolved: false,
};

function nzbFile(contents = NZB): File {
  return new File([contents], 'release.nzb', { type: 'application/x-nzb' });
}

/** A mock `uploadNzb` implementation that never settles. */
function neverResolves(): Promise<never> {
  return new Promise<never>(() => {
    // Deliberately never settles: the file list must not be waiting on it.
  });
}

interface RenderOverrides {
  readonly uploadNzb?: (file: File) => Promise<JobDto>;
}

function renderLibrary(overrides: RenderOverrides = {}): {
  readonly onPlay: ReturnType<typeof vi.fn>;
} {
  const onPlay = vi.fn();
  const uploadNzb = overrides.uploadNzb ?? vi.fn(neverResolves);
  render(<Library uploadNzb={uploadNzb} onPlay={onPlay} jobs={[]} onRefresh={vi.fn()} />);
  return { onPlay };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parsing a dropped NZB', () => {
  it('renders the file list from a dropped NZB before any network call', async () => {
    const upload = vi.fn(neverResolves);
    renderLibrary({ uploadNzb: upload });

    await userEvent.upload(screen.getByLabelText(/nzb file/iu), nzbFile());

    expect(await screen.findByText('Some.Film.mp4')).toBeDefined();
    expect(screen.getByText('Some.Film.nfo')).toBeDefined();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('only lets an MP4 be played', async () => {
    renderLibrary();
    await userEvent.upload(screen.getByLabelText(/nzb file/iu), nzbFile());

    await screen.findByText('Some.Film.mp4');
    const buttons = screen.getAllByRole('button', { name: /play/iu });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.hasAttribute('disabled')).toBe(false);
    expect(buttons[1]?.hasAttribute('disabled')).toBe(true);
  });

  it('offers every file when no name has a usable extension', async () => {
    const obfuscated = NZB.replaceAll('Some.Film.mp4', 'a7f3b2c1').replaceAll(
      'Some.Film.nfo',
      'd8e4f5a6',
    );
    renderLibrary();
    await userEvent.upload(screen.getByLabelText(/nzb file/iu), nzbFile(obfuscated));

    await screen.findByText('a7f3b2c1');
    expect(screen.getByText(/could not be determined/iu)).toBeDefined();
    for (const button of screen.getAllByRole('button', { name: /play/iu })) {
      expect(button.hasAttribute('disabled')).toBe(false);
    }
  });
});

describe('after parsing', () => {
  it('reports a malformed NZB without calling the server', async () => {
    const upload = vi.fn();
    renderLibrary({ uploadNzb: upload });

    await userEvent.upload(
      screen.getByLabelText(/nzb file/iu),
      new File(['<nzb><file>'], 'bad.nzb', { type: 'application/x-nzb' }),
    );

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(upload).not.toHaveBeenCalled();
  });

  it('plays the selected file once the upload has produced a job', async () => {
    const upload = vi.fn(() => Promise.resolve(JOB));
    const { onPlay } = renderLibrary({ uploadNzb: upload });

    await userEvent.upload(screen.getByLabelText(/nzb file/iu), nzbFile());
    await screen.findByText('Some.Film.mp4');

    await userEvent.click(screen.getAllByRole('button', { name: /play/iu })[0]!);
    await waitFor(() => expect(onPlay).toHaveBeenCalledWith('job1', 0));
  });
});
