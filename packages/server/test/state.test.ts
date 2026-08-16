import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JobStateWriter,
  parseJobState,
  readJobState,
  writeJobState,
  type JobState,
} from '../src/jobs/state.ts';

// Mocked so failure-path tests can inject a rejection into a specific write,
// and so the coalescing test can assert exactly one write call rather than
// only inspecting the resulting bytes (three sequential writes converging on
// the same final content would look identical to one write otherwise).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

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

function noop(): void {}

// mockClear() would only wipe call history; a mockImplementationOnce that its
// own test never consumed would survive into the next test and be spent by the
// wrong write. mockReset() is what drains that queue.
//
// Vitest 4's mockReset() also restores the implementation vi.fn() was
// constructed with, so the passthrough would come back on its own. It is
// re-supplied explicitly anyway: the success paths here are worthless without
// a real writeFile, and that should not rest on a mock-reset nuance that has
// already changed once across Vitest majors.
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const mocked = vi.mocked(writeFile);
  mocked.mockReset();
  mocked.mockImplementation(actual.writeFile);
});

afterEach(() => {
  vi.useRealTimers();
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
  it('coalesces rapid updates into exactly one write', async () => {
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

    expect(vi.mocked(writeFile).mock.calls.length).toBe(1);
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

describe('JobStateWriter - explicit flush surfaces its own failure', () => {
  it('rejects to an explicitly awaited flush() rather than retrying silently', async () => {
    const dir = await scratch();
    const writer = new JobStateWriter(dir, 60_000);
    vi.mocked(writeFile).mockImplementationOnce(() => Promise.reject(new Error('EACCES')));

    writer.schedule({ ...sample, status: 'complete' });
    await expect(writer.flush()).rejects.toThrow('EACCES');

    // The writer must still be usable afterward: the failed explicit flush
    // must not permanently jam the internal write chain.
    writer.schedule({ ...sample, status: 'paused' });
    await writer.flush();
    expect((await readJobState(dir)).status).toBe('paused');
    await writer.dispose();
  });
});

describe('JobStateWriter - retries a failed timer-driven write', () => {
  it('does not crash the process and retries until the write succeeds', async () => {
    vi.useFakeTimers();
    const dir = await scratch();
    const onError = vi.fn();
    const writer = new JobStateWriter(dir, 1_000, onError);
    vi.mocked(writeFile).mockImplementationOnce(() => Promise.reject(new Error('ENOSPC')));

    writer.schedule({ ...sample, status: 'paused' });
    // The first attempt fails. If this rejection were left unhandled, the
    // test run itself would fail via Vitest's unhandled-rejection detection.
    //
    // writeJobState's failure path unlinks the temp file before rethrowing, so
    // reaching onError costs a real filesystem round trip, not a fixed number
    // of microtask hops. Wait on the condition; vi.waitFor polls on the real
    // clock, which is what lets that unlink actually complete.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    // The debounce re-armed itself; the retry lands on its own.
    await vi.advanceTimersByTimeAsync(1_000);
    await writer.flush();
    expect((await readJobState(dir)).status).toBe('paused');
    await writer.dispose();
  });
});

describe('JobStateWriter - supersession of a failed retry', () => {
  it('lets a state scheduled while the failed write was in flight supersede it', async () => {
    vi.useFakeTimers();
    const dir = await scratch();
    const onError = vi.fn();
    const writer = new JobStateWriter(dir, 1_000, onError);
    let rejectWrite: (error: Error) => void = noop;
    vi.mocked(writeFile).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );

    writer.schedule({ ...sample, status: 'paused' });
    await vi.advanceTimersByTimeAsync(1_000);
    // The write above is still pending (its promise was never settled), so
    // #pending is back to null. Schedule a newer state while it hangs.
    writer.schedule({ ...sample, status: 'complete' });
    rejectWrite(new Error('EACCES'));
    // Same real-filesystem round trip as above, so wait for the report rather
    // than for a tick count.
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await writer.flush();
    expect((await readJobState(dir)).status).toBe('complete');
    expect(onError).toHaveBeenCalledTimes(1);
    await writer.dispose();
  });
});

describe('JobStateWriter - onError defaults', () => {
  it('defaults to a no-op when no callback is supplied', async () => {
    vi.useFakeTimers();
    const dir = await scratch();
    const writer = new JobStateWriter(dir, 1_000);
    let rejectWrite: (error: Error) => void = noop;
    vi.mocked(writeFile).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );

    writer.schedule({ ...sample, status: 'paused' });
    await vi.advanceTimersByTimeAsync(1_000);
    // The timer has already taken the state out of the writer and its write is
    // hanging, so a flush entered here sees nothing pending. Failing the write
    // only once flush() is under way drives the default onError and pins the
    // window where the state lives nowhere but in memory: flush() has to land
    // it rather than leave it to a retry timer a shutdown would never run.
    const flushed = writer.flush();
    rejectWrite(new Error('boom'));
    await flushed;

    expect((await readJobState(dir)).status).toBe('paused');
    await writer.dispose();
  });
});
