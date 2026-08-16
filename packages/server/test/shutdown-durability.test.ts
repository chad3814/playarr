import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobStateWriter, readJobState, type JobState } from '../src/jobs/state.ts';
import { JobStore } from '../src/jobs/store.ts';

// Every test here needs a write it can fail, or complete, at a moment of its
// own choosing, so the interleaving under test is pinned open rather than
// waited for.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const NZB = `<?xml version="1.0" encoding="iso-8859-1" ?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="p@example.com" date="1700000000" subject="[1/1] - &quot;Some.Film.mp4&quot; yEnc (1/1)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="1000" number="1">a1@example.com</segment></segments>
  </file>
</nzb>`;

const sample: JobState = {
  id: 'j1',
  createdAt: '2026-08-10T00:00:00.000Z',
  nzbName: 'release.nzb',
  status: 'ready',
};

function noop(): void {}

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'playarr-durable-'));
}

/** Queues a write that hangs until the caller fails it. */
function hangingWrite(): { fail: (error: Error) => void } {
  const control = { fail: noop as (error: Error) => void };
  vi.mocked(writeFile).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        control.fail = reject;
      }),
  );
  return control;
}

/** Queues a write that hangs until released, then really writes. */
async function heldWrite(): Promise<{ release: () => void }> {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const control = { release: noop };
  const held = new Promise<void>((resolve) => {
    control.release = resolve;
  });
  vi.mocked(writeFile).mockImplementationOnce(async (file, data, options) => {
    await held;
    await actual.writeFile(file, data, options);
  });
  return control;
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const mocked = vi.mocked(writeFile);
  mocked.mockReset();
  mocked.mockImplementation(actual.writeFile);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JobStateWriter.flush - a superseded state must never be written last', () => {
  it('leaves the newest state on disk when an older write fails mid-flush', async () => {
    vi.useFakeTimers();
    const dir = await scratch();
    const writer = new JobStateWriter(dir, 1_000, noop);
    const stale = hangingWrite();

    writer.schedule({ ...sample, status: 'paused' });
    await vi.advanceTimersByTimeAsync(1_000);
    // The timer is holding 'paused' inside a write that has not settled.
    // 'complete' is strictly newer, and the flush below takes it, so the older
    // write must not be allowed to hand 'paused' back and have it written on
    // top of the state that superseded it.
    writer.schedule({ ...sample, status: 'complete' });
    const flushed = writer.flush();
    stale.fail(new Error('EACCES'));
    await flushed;

    expect((await readJobState(dir)).status).toBe('complete');
    await writer.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await readJobState(dir)).status).toBe('complete');
  });
});

describe('JobStateWriter.flush - no write it started may outlive it', () => {
  it('arms no retry that lands after flush() has already resolved', async () => {
    vi.useFakeTimers();
    const dir = await scratch();
    const onError = vi.fn();
    const writer = new JobStateWriter(dir, 1_000, onError);
    const stale = hangingWrite();
    const flushWrite = await heldWrite();

    writer.schedule({ ...sample, status: 'paused' });
    await vi.advanceTimersByTimeAsync(1_000);
    writer.schedule({ ...sample, status: 'complete' });
    const flushed = writer.flush();
    stale.fail(new Error('EACCES'));

    // The failed write reports only after a real unlink round trip, so wait on
    // the report rather than on a tick count: whatever it re-arms has to exist
    // before the clock is allowed to move. The flush's own write is still held,
    // so anything re-armed gets a whole interval to fire underneath it.
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    flushWrite.release();
    await flushed;

    const issued = vi.mocked(writeFile).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(writeFile).mock.calls.length).toBe(issued);
    // dispose() awaits the writer's whole chain, so this settles any straggler
    // rather than racing its rename.
    await writer.dispose();
    expect((await readJobState(dir)).status).toBe('complete');
  });
});

describe('JobStore.remove - a failed final write must not leave a retry loop', () => {
  it('stops retrying into the directory it just deleted', async () => {
    vi.useFakeTimers();
    const root = await scratch();
    const onWriteError = vi.fn();
    const store = new JobStore(
      root,
      () => new Date(0),
      () => 'job1',
      onWriteError,
    );
    const record = await store.create('release.nzb', Buffer.from(NZB, 'utf8'));
    const stale = hangingWrite();
    vi.mocked(writeFile).mockImplementationOnce(() => Promise.reject(new Error('ENOSPC')));

    await store.update('job1', { ...record.state, status: 'paused' });
    await vi.advanceTimersByTimeAsync(1_000);
    await store.update('job1', { ...record.state, status: 'complete' });

    // remove() runs far enough synchronously for its flush to have taken
    // 'complete' before the older write is failed underneath it.
    const removed = store.remove('job1');
    stale.fail(new Error('EACCES'));
    await removed;

    await expect(stat(join(root, 'job1'))).rejects.toThrow();
    const issued = vi.mocked(writeFile).mock.calls.length;
    onWriteError.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(writeFile).mock.calls.length).toBe(issued);
    expect(onWriteError).not.toHaveBeenCalled();
    await store.dispose();
  });
});
