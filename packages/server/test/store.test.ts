import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobStore, type JobRecord } from '../src/jobs/store.ts';
import { readJobState, writeJobState } from '../src/jobs/state.ts';

// Mocked so the onWriteError test can inject a rejection into a specific
// write without touching the timer-driven retry logic under test.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const NZB = `<?xml version="1.0" encoding="iso-8859-1" ?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="p@example.com" date="1700000000" subject="[1/1] - &quot;Some.Film.mp4&quot; yEnc (1/2)">
    <groups><group>alt.binaries.test</group></groups>
    <segments>
      <segment bytes="1000" number="1">a1@example.com</segment>
      <segment bytes="1000" number="2">a2@example.com</segment>
    </segments>
  </file>
</nzb>`;

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'playarr-store-'));
}

function fixedStore(root: string): JobStore {
  let counter = 0;
  return new JobStore(
    root,
    () => new Date('2026-08-10T00:00:00.000Z'),
    () => `job${(counter += 1)}`,
  );
}

/** Forces a record's in-memory state to carry the given (possibly unsafe) selection name. */
function withSelection(store: JobStore, id: string, name: string): JobRecord {
  const record = store.get(id);
  if (record === undefined) {
    throw new Error(`missing record: ${id}`);
  }
  record.state = {
    ...record.state,
    selection: {
      fileIndex: 0,
      name,
      size: 2_000,
      geometry: { segmentSize: 1_000, lastSegmentSize: 1_000, segmentCount: 2 },
      covered: [],
      dead: [],
    },
  };
  return record;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('JobStore.create', () => {
  it('writes a directory holding the nzb and its state', async () => {
    const root = await scratch();
    const store = fixedStore(root);
    const record = await store.create('release.nzb', Buffer.from(NZB, 'utf8'));

    expect(record.state.id).toBe('job1');
    expect(record.state.status).toBe('uploaded');
    expect(record.state.nzbName).toBe('release.nzb');
    expect(record.nzb.files).toHaveLength(1);

    const dir = join(root, 'job1');
    expect(await readFile(join(dir, 'source.nzb'), 'utf8')).toBe(NZB);
    expect((await stat(join(dir, 'state.json'))).isFile()).toBe(true);
    await store.dispose();
  });

  it('propagates the parser error without writing anything', async () => {
    const root = await scratch();
    const store = fixedStore(root);
    await expect(store.create('bad.nzb', Buffer.from('<nzb><file>', 'utf8'))).rejects.toThrow();
    expect(store.list()).toHaveLength(0);
    await store.dispose();
  });
});

describe('JobStore.scan - rebuilding from disk', () => {
  it('rebuilds records from disk', async () => {
    const root = await scratch();
    const first = fixedStore(root);
    await first.create('release.nzb', Buffer.from(NZB, 'utf8'));
    await first.dispose();

    const second = new JobStore(root);
    await second.scan();
    expect(second.list().map((record) => record.state.id)).toEqual(['job1']);
    await second.dispose();
  });
});

describe('JobStore.scan - corrupt state', () => {
  it('marks a job failed when its state is corrupt rather than guessing', async () => {
    const root = await scratch();
    const dir = join(root, 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'source.nzb'), NZB, 'utf8');
    await writeFile(join(dir, 'state.json'), 'not json', 'utf8');

    const store = new JobStore(root);
    await store.scan();

    const record = store.get('broken');
    expect(record?.state.status).toBe('failed');
    expect(record?.state.failure?.code).toBe('corrupt-state');
    await store.dispose();
  });
});

describe('JobStore.scan - resuming from a previous ready state', () => {
  it('brings a previously ready job back paused', async () => {
    const root = await scratch();
    const dir = join(root, 'job9');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'source.nzb'), NZB, 'utf8');
    await writeJobState(dir, {
      id: 'job9',
      createdAt: '2026-08-10T00:00:00.000Z',
      nzbName: 'release.nzb',
      status: 'ready',
      selection: {
        fileIndex: 0,
        name: 'Some.Film.mp4',
        size: 2_000,
        geometry: { segmentSize: 1_000, lastSegmentSize: 1_000, segmentCount: 2 },
        covered: [[0, 1]],
        dead: [],
      },
    });

    const store = new JobStore(root);
    await store.scan();
    expect(store.get('job9')?.state.status).toBe('paused');
    await store.dispose();
  });
});

describe('JobStore.scan - directories without a job', () => {
  it('ignores a directory with no source.nzb', async () => {
    const root = await scratch();
    await mkdir(join(root, 'stray'), { recursive: true });
    const store = new JobStore(root);
    await store.scan();
    expect(store.list()).toHaveLength(0);
    await store.dispose();
  });
});

describe('JobStore.remove', () => {
  it('deletes the directory and forgets the record', async () => {
    const root = await scratch();
    const store = fixedStore(root);
    await store.create('release.nzb', Buffer.from(NZB, 'utf8'));
    await store.remove('job1');

    expect(store.get('job1')).toBeUndefined();
    await expect(stat(join(root, 'job1'))).rejects.toThrow();
    await store.dispose();
  });
});

describe('JobStore.remove - a failing final write', () => {
  it('deletes the directory even when the last state write fails', async () => {
    const root = await scratch();
    const store = fixedStore(root);
    const record = await store.create('release.nzb', Buffer.from(NZB, 'utf8'));

    await store.update('job1', { ...record.state, status: 'complete' });
    vi.mocked(writeFile).mockImplementationOnce(() => Promise.reject(new Error('ENOSPC')));
    await store.remove('job1');

    expect(store.get('job1')).toBeUndefined();
    await expect(stat(join(root, 'job1'))).rejects.toThrow();
    await store.dispose();
  });
});

describe('JobStore.dispose - one writer failing must not abandon the rest', () => {
  it('flushes every writer and reports every failure', async () => {
    const root = await scratch();
    const store = fixedStore(root);
    const one = await store.create('a.nzb', Buffer.from(NZB, 'utf8'));
    const two = await store.create('b.nzb', Buffer.from(NZB, 'utf8'));
    const three = await store.create('c.nzb', Buffer.from(NZB, 'utf8'));

    // Deleting the directories is what makes the first two writes fail, so the
    // failure is a real ENOENT from the filesystem rather than a mock whose
    // turn depends on the order the writers happen to start in.
    await rm(join(root, 'job1'), { recursive: true, force: true });
    await rm(join(root, 'job2'), { recursive: true, force: true });
    await store.update('job1', { ...one.state, status: 'paused' });
    await store.update('job2', { ...two.state, status: 'paused' });
    await store.update('job3', { ...three.state, status: 'complete' });

    const failure = await store.dispose().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: expect.stringContaining('job1, job2'),
      errors: [expect.any(Error), expect.any(Error)],
    });
    // The surviving writer must have been flushed and awaited, not abandoned
    // the moment the first one rejected.
    expect((await readJobState(join(root, 'job3'))).status).toBe('complete');
  });
});

describe('JobStore.outputPath - valid selection', () => {
  it('returns the expected path for a normal name', async () => {
    const root = await scratch();
    const store = fixedStore(root);
    await store.create('release.nzb', Buffer.from(NZB, 'utf8'));
    const record = withSelection(store, 'job1', 'Some.Film.mp4');
    expect(store.outputPath(record)).toBe(join(root, 'job1', 'Some.Film.mp4'));
    await store.dispose();
  });
});

describe('JobStore.outputPath - no selection', () => {
  it('throws when there is no selected file', async () => {
    const root = await scratch();
    const store = fixedStore(root);
    const record = await store.create('release.nzb', Buffer.from(NZB, 'utf8'));
    expect(() => store.outputPath(record)).toThrow(/no selected file/u);
    await store.dispose();
  });
});

describe('JobStore.outputPath - unsafe selection names', () => {
  it.each([
    ['a forward slash', '../../etc/cron.d/x'],
    ['a backslash', '..\\..\\windows\\x'],
    ['..', '..'],
    ['the empty string', ''],
  ])('throws for a name containing %s', async (_label, name) => {
    const root = await scratch();
    const store = fixedStore(root);
    await store.create('release.nzb', Buffer.from(NZB, 'utf8'));
    const record = withSelection(store, 'job1', name);
    expect(() => store.outputPath(record)).toThrow(/unsafe selection name/u);
    await store.dispose();
  });
});

describe('JobStore.update - onWriteError', () => {
  it('reports a failing debounced write through onWriteError with the job id', async () => {
    vi.useFakeTimers();
    const root = await scratch();
    const onWriteError = vi.fn();
    const store = new JobStore(
      root,
      () => new Date('2026-08-10T00:00:00.000Z'),
      () => 'job1',
      onWriteError,
    );
    const record = await store.create('release.nzb', Buffer.from(NZB, 'utf8'));

    vi.mocked(writeFile).mockImplementationOnce(() => Promise.reject(new Error('ENOSPC')));
    await store.update('job1', { ...record.state, status: 'paused' });

    // writeJobState's failure path unlinks the temp file before rethrowing, so
    // reaching onWriteError costs a real filesystem round trip rather than a
    // fixed number of microtask hops. vi.waitFor polls on the real clock,
    // which is what lets that unlink complete.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(onWriteError).toHaveBeenCalledTimes(1);
    });

    expect(onWriteError.mock.calls[0]?.[0]).toBe('job1');
    expect(onWriteError.mock.calls[0]?.[1]).toBeInstanceOf(Error);

    await vi.advanceTimersByTimeAsync(1_000);
    await store.dispose();
  });
});
