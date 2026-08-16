import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/jobs/store.ts';
import { writeJobState } from '../src/jobs/state.ts';

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
  return mkdtemp(join(tmpdir(), 'playarr-scan-'));
}

function fixedStore(root: string): JobStore {
  let counter = 0;
  return new JobStore(
    root,
    () => new Date('2026-08-10T00:00:00.000Z'),
    () => `job${(counter += 1)}`,
  );
}

/** A job directory holding a real NZB and whatever state.json text is given. */
async function jobDir(root: string, name: string, state: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'source.nzb'), NZB, 'utf8');
  await writeFile(join(dir, 'state.json'), state, 'utf8');
  return dir;
}

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

/** A state.json that parses field by field but describes an impossible file. */
const OUT_OF_RANGE = JSON.stringify({
  id: 'impossible',
  createdAt: '2026-08-10T00:00:00.000Z',
  nzbName: 'release.nzb',
  status: 'paused',
  selection: {
    fileIndex: 0,
    name: 'Some.Film.mp4',
    size: 2_000,
    geometry: { segmentSize: 1_000, lastSegmentSize: 1_000, segmentCount: 2 },
    covered: [[0, 999_999]],
    dead: [],
  },
});

describe('JobStore.scan - corrupt state', () => {
  it.each([
    ['unreadable', 'broken', 'not json'],
    // [0, 999999) over a two-segment file is not a coverage any run of this
    // program produced. Unvalidated it is a RangeError from SegmentCoverage
    // inside JobManager.#activate -- a generic 500 on whatever request touched
    // the job, long after the scan that should have failed it.
    ['out of range', 'impossible', OUT_OF_RANGE],
  ])('marks a job failed when its state is %s rather than guessing', async (_l, name, state) => {
    const root = await scratch();
    await jobDir(root, name, state);

    const store = new JobStore(root);
    await store.scan();

    expect(store.get(name)?.state.status).toBe('failed');
    expect(store.get(name)?.state.failure?.code).toBe('corrupt-state');
    // Nothing here knows what the upload was called, so it must not invent
    // one: 'source.nzb' is the name of the file on disk, and rendering it as
    // the job's title claims metadata this record does not have.
    expect(store.get(name)?.state.nzbName).toBe(name);
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
