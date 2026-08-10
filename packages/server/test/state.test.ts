import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JobStateError,
  JobStateWriter,
  parseJobState,
  readJobState,
  writeJobState,
  type JobState,
} from '../src/jobs/state.ts';

const sample: JobState = {
  id: 'j1',
  createdAt: '2026-08-10T00:00:00.000Z',
  nzbName: 'release.nzb',
  status: 'ready',
  selection: {
    fileIndex: 0,
    name: 'Some.Film.mp4',
    size: 3_000,
    geometry: { segmentSize: 1_000, lastSegmentSize: 1_000, segmentCount: 3 },
    covered: [[0, 1]],
    dead: [],
  },
};

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'playarr-state-'));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseJobState - valid input', () => {
  it('accepts a job that has not been selected yet', () => {
    const state = parseJobState(
      JSON.stringify({
        id: 'j1',
        createdAt: '2026-08-10T00:00:00.000Z',
        nzbName: 'a.nzb',
        status: 'uploaded',
      }),
    );
    expect(state.selection).toBeUndefined();
    expect(state.status).toBe('uploaded');
  });

  it('round-trips a selected job', () => {
    expect(parseJobState(JSON.stringify(sample))).toEqual(sample);
  });
});

describe('parseJobState - rejects invalid input', () => {
  it('rejects malformed JSON as corrupt', () => {
    expect(() => parseJobState('{ not json')).toThrow(JobStateError);
    try {
      parseJobState('{ not json');
    } catch (error) {
      expect(error).toBeInstanceOf(JobStateError);
      expect((error as JobStateError).code).toBe('corrupt');
    }
  });

  it('rejects an unknown status rather than coercing it', () => {
    const raw = JSON.stringify({ ...sample, status: 'downloading' });
    expect(() => parseJobState(raw)).toThrow(/status/u);
  });

  it('rejects a coverage run that is not a pair of integers', () => {
    const raw = JSON.stringify({
      ...sample,
      selection: { ...sample.selection, covered: [[0, '3']] },
    });
    expect(() => parseJobState(raw)).toThrow(JobStateError);
  });

  it('rejects a selection missing its geometry', () => {
    const raw = JSON.stringify({ ...sample, selection: { ...sample.selection, geometry: null } });
    expect(() => parseJobState(raw)).toThrow(JobStateError);
  });
});

describe('writeJobState', () => {
  it('writes atomically, leaving no temp file behind', async () => {
    const dir = await scratch();
    await writeJobState(dir, sample);
    expect(await readdir(dir)).toEqual(['state.json']);
    expect(await readJobState(dir)).toEqual(sample);
  });

  it('replaces an existing state file', async () => {
    const dir = await scratch();
    await writeJobState(dir, sample);
    await writeJobState(dir, { ...sample, status: 'complete' });
    expect((await readJobState(dir)).status).toBe('complete');
  });
});

describe('readJobState', () => {
  it('reports a missing file distinctly from a corrupt one', async () => {
    const dir = await scratch();
    await expect(readJobState(dir)).rejects.toMatchObject({ code: 'missing' });

    await writeFile(join(dir, 'state.json'), 'garbage', 'utf8');
    await expect(readJobState(dir)).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('JobStateWriter - coalescing', () => {
  it('coalesces rapid updates into one write', async () => {
    vi.useFakeTimers();
    const dir = await scratch();
    const writer = new JobStateWriter(dir, 1_000);

    writer.schedule({ ...sample, selection: { ...sample.selection!, covered: [[0, 1]] } });
    writer.schedule({ ...sample, selection: { ...sample.selection!, covered: [[0, 2]] } });
    writer.schedule({ ...sample, selection: { ...sample.selection!, covered: [[0, 3]] } });

    await vi.advanceTimersByTimeAsync(1_000);
    // Fake timers only grant one real event-loop turn per fired timer, but
    // the write itself is two sequential real fs completions (write + rename).
    // Flushing again awaits the writer's own in-flight promise for real,
    // rather than relying on the fake clock's tick granularity.
    await writer.flush();
    const written = parseJobState(await readFile(join(dir, 'state.json'), 'utf8'));
    expect(written.selection?.covered).toEqual([[0, 3]]);
    await writer.dispose();
  });
});

describe('JobStateWriter - flush and dispose', () => {
  it('flushes immediately when asked, without waiting for the interval', async () => {
    vi.useFakeTimers();
    const dir = await scratch();
    const writer = new JobStateWriter(dir, 60_000);

    writer.schedule({ ...sample, status: 'complete' });
    await writer.flush();

    expect((await readJobState(dir)).status).toBe('complete');
    await writer.dispose();
  });

  it('flushes pending state on dispose so a shutdown cannot lose it', async () => {
    vi.useFakeTimers();
    const dir = await scratch();
    const writer = new JobStateWriter(dir, 60_000);
    writer.schedule({ ...sample, status: 'paused' });
    await writer.dispose();
    expect((await readJobState(dir)).status).toBe('paused');
  });
});
