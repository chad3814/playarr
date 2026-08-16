import { describe, expect, it } from 'vitest';
import { JobStateError, parseJobState, type JobState } from '../src/jobs/state.ts';

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

describe('parseJobState - coverage that cannot describe this file', () => {
  // Each of these is accepted by the field-level checks and then rejected by
  // SegmentCoverage's constructor, which nothing between here and
  // JobManager.#activate catches -- so the job would come back from a scan
  // looking fine and 500 the first request that touched it, instead of being
  // failed at boot the way an unparseable state.json already is.
  it.each([
    ['a run that ends before it starts', { covered: [[3, 1]] }],
    ['a run past the last segment', { covered: [[0, 999_999]] }],
    ['a dead segment past the last one', { dead: [10] }],
  ])('rejects %s as corrupt', (_label, override) => {
    const raw = JSON.stringify({ ...sample, selection: { ...sample.selection, ...override } });
    expect(() => parseJobState(raw)).toThrow(JobStateError);
    try {
      parseJobState(raw);
    } catch (error) {
      expect((error as JobStateError).code).toBe('corrupt');
    }
  });

  it('accepts a run that ends exactly at the last segment', () => {
    const raw = JSON.stringify({
      ...sample,
      selection: { ...sample.selection, covered: [[0, 3]] },
    });
    expect(parseJobState(raw).selection?.covered).toEqual([[0, 3]]);
  });
});
