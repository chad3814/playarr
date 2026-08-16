import type { JobFailure, JobStatus, SegmentRun } from '@playarr/shared';

export const STATE_FILENAME = 'state.json';

const STATUSES: readonly JobStatus[] = [
  'uploaded',
  'ready',
  'paused',
  'completing',
  'complete',
  'failed',
];

export interface JobGeometry {
  readonly segmentSize: number;
  readonly lastSegmentSize: number;
  readonly segmentCount: number;
}

export interface JobSelection {
  readonly fileIndex: number;
  readonly name: string;
  readonly size: number;
  readonly geometry: JobGeometry;
  readonly covered: readonly SegmentRun[];
  readonly dead: readonly number[];
}

export interface JobState {
  readonly id: string;
  readonly createdAt: string;
  readonly nzbName: string;
  readonly status: JobStatus;
  readonly failure?: JobFailure;
  readonly selection?: JobSelection;
}

export class JobStateError extends Error {
  readonly code: 'corrupt' | 'missing';

  constructor(code: 'corrupt' | 'missing', message: string) {
    super(message);
    this.name = 'JobStateError';
    this.code = code;
  }
}

type Json = Record<string, unknown>;

function corrupt(message: string): never {
  throw new JobStateError('corrupt', message);
}

function object(value: unknown, field: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    corrupt(`${field} must be an object`);
  }
  return value as Json;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    corrupt(`${field} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    corrupt(`${field} must be a non-negative integer`);
  }
  return value;
}

function status(value: unknown): JobStatus {
  const found = STATUSES.find((candidate) => candidate === value);
  if (found === undefined) {
    corrupt(`status must be one of ${STATUSES.join(', ')}`);
  }
  return found;
}

/**
 * Coverage runs, checked against the geometry they claim to describe.
 *
 * A pair that ends before it starts, or that runs past the last segment,
 * satisfies every field-level check above and is then rejected by
 * `SegmentCoverage`'s constructor — as an uncaught `RangeError` inside
 * `JobManager.#activate`, surfacing as a generic 500 on whatever request
 * happened to touch the job. A state.json that cannot describe a real file is
 * corrupt, and the spec says a corrupt state.json fails the job at boot, so it
 * is caught here where `JobStore.#loadState` already knows what to do with it.
 */
function runs(value: unknown, field: string, segmentCount: number): SegmentRun[] {
  if (!Array.isArray(value)) {
    corrupt(`${field} must be an array`);
  }
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      corrupt(`${field}[${index}] must be a [start, end) pair`);
    }
    const start = integer(entry[0], `${field}[${index}][0]`);
    const end = integer(entry[1], `${field}[${index}][1]`);
    if (end < start) {
      corrupt(`${field}[${index}] ends before it starts: [${start}, ${end})`);
    }
    if (end > segmentCount) {
      corrupt(`${field}[${index}] runs past segment ${segmentCount}: [${start}, ${end})`);
    }
    return [start, end];
  });
}

/** Dead segment indices, bounded by the same geometry as `covered`. */
function deadSegments(value: unknown, segmentCount: number): number[] {
  if (!Array.isArray(value)) {
    corrupt('selection.dead must be an array');
  }
  return value.map((entry, index) => {
    const segment = integer(entry, `selection.dead[${index}]`);
    if (segment >= segmentCount) {
      corrupt(`selection.dead[${index}] is not a segment of this file: ${segment}`);
    }
    return segment;
  });
}

function geometry(value: unknown): JobGeometry {
  const raw = object(value, 'selection.geometry');
  return {
    segmentSize: integer(raw['segmentSize'], 'selection.geometry.segmentSize'),
    lastSegmentSize: integer(raw['lastSegmentSize'], 'selection.geometry.lastSegmentSize'),
    segmentCount: integer(raw['segmentCount'], 'selection.geometry.segmentCount'),
  };
}

function selection(value: unknown): JobSelection {
  const raw = object(value, 'selection');
  const shape = geometry(raw['geometry']);
  return {
    fileIndex: integer(raw['fileIndex'], 'selection.fileIndex'),
    name: string(raw['name'], 'selection.name'),
    size: integer(raw['size'], 'selection.size'),
    geometry: shape,
    covered: runs(raw['covered'], 'selection.covered', shape.segmentCount),
    dead: deadSegments(raw['dead'], shape.segmentCount),
  };
}

function failure(value: unknown): JobFailure {
  const raw = object(value, 'failure');
  return {
    code: string(raw['code'], 'failure.code'),
    message: string(raw['message'], 'failure.message'),
  };
}

export function parseJobState(text: string): JobState {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    corrupt(`state.json is not valid JSON: ${(error as Error).message}`);
  }

  const raw = object(decoded, 'state');
  const state: JobState = {
    id: string(raw['id'], 'id'),
    createdAt: string(raw['createdAt'], 'createdAt'),
    nzbName: string(raw['nzbName'], 'nzbName'),
    status: status(raw['status']),
    ...(raw['failure'] === undefined ? {} : { failure: failure(raw['failure']) }),
    ...(raw['selection'] === undefined ? {} : { selection: selection(raw['selection']) }),
  };
  return state;
}
