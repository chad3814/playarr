import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

function runs(value: unknown, field: string): SegmentRun[] {
  if (!Array.isArray(value)) {
    corrupt(`${field} must be an array`);
  }
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      corrupt(`${field}[${index}] must be a [start, end) pair`);
    }
    return [integer(entry[0], `${field}[${index}][0]`), integer(entry[1], `${field}[${index}][1]`)];
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
  return {
    fileIndex: integer(raw['fileIndex'], 'selection.fileIndex'),
    name: string(raw['name'], 'selection.name'),
    size: integer(raw['size'], 'selection.size'),
    geometry: geometry(raw['geometry']),
    covered: runs(raw['covered'], 'selection.covered'),
    dead: Array.isArray(raw['dead'])
      ? raw['dead'].map((entry, index) => integer(entry, `selection.dead[${index}]`))
      : corrupt('selection.dead must be an array'),
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

export async function readJobState(dir: string): Promise<JobState> {
  let text: string;
  try {
    text = await readFile(join(dir, STATE_FILENAME), 'utf8');
  } catch {
    throw new JobStateError('missing', `no ${STATE_FILENAME} in ${dir}`);
  }
  return parseJobState(text);
}

/**
 * Write via a temp file and rename, so a crash mid-write cannot leave a
 * truncated state.json. Nothing else knows which bytes of the sparse file are
 * real, so a partial write is unrecoverable rather than merely stale.
 */
export async function writeJobState(dir: string, state: JobState): Promise<void> {
  const target = join(dir, STATE_FILENAME);
  const temp = `${target}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Coalesces coverage updates, which otherwise land once per fetched article.
 *
 * The debounce exists only to avoid a write per 4 MiB. It must never be the
 * reason a status change is lost, so callers flush on every transition and on
 * shutdown. A write that fails on its own (the timer-driven path, not an
 * explicit `flush()`) is retried rather than dropped: the failed state is put
 * back and the debounce is re-armed, unless something newer appeared while it
 * was in flight — scheduled by the owner, or taken by a `flush()` — in which
 * case the newer wins and the failed state is dropped rather than written over
 * its own successor. `onError` lets the owner learn of the failure (to mark
 * the job failed, for instance) without ever surfacing an unhandled rejection.
 */
export class JobStateWriter {
  readonly #dir: string;
  readonly #intervalMs: number;
  readonly #onError: (error: Error) => void;
  #pending: JobState | null = null;
  /**
   * Counts states taken for writing, so a failing write can tell "nothing has
   * happened since" from "something newer was already taken". `#pending` alone
   * reads as null in both cases.
   */
  #taken = 0;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> = Promise.resolve();

  constructor(dir: string, intervalMs = 1_000, onError: (error: Error) => void = () => {}) {
    this.#dir = dir;
    this.#intervalMs = intervalMs;
    this.#onError = onError;
  }

  schedule(state: JobState): void {
    this.#pending = state;
    this.#arm();
  }

  /**
   * Two passes, because a timer-driven write that is failing has already taken
   * its state out of `#pending` and does not hand it back until its own catch
   * handler runs — and that handler is the tail of `#inFlight`, still queued
   * behind the promise the first pass awaits. In that window `#pending` reads
   * as null, so the first pass writes nothing, and returning there would let
   * `dispose()` report a clean shutdown while the state was only in memory,
   * owned by an unref'd retry timer that exit will never run.
   *
   * One re-check covers the writer's own retry: awaiting `#inFlight` drains
   * every handler that could restore `#pending`, and a handler restores only
   * when its write was the most recent take, so the second pass has at most
   * one state to write. A `schedule()` from outside during the flush is
   * deliberately not covered — the debounce may take it and write it after
   * this returns. `flush()` promises to land everything scheduled before it
   * was called, not everything scheduled while it runs.
   */
  async flush(): Promise<void> {
    await this.#flushOnce();
    if (this.#pending !== null) {
      await this.#flushOnce();
    }
  }

  async dispose(): Promise<void> {
    await this.flush();
  }

  #flushOnce(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const state = this.#pending;
    this.#pending = null;
    if (state === null) {
      return this.#inFlight;
    }
    this.#taken += 1;
    // Swallow whatever the previous attempt left behind so one failure
    // cannot permanently jam every write after it.
    this.#inFlight = this.#inFlight.catch(() => {}).then(() => writeJobState(this.#dir, state));
    return this.#inFlight;
  }

  #arm(): void {
    if (this.#timer !== null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flushFromTimer();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  /**
   * The timer-driven counterpart to `flush()`. Unlike `flush()`, a failure
   * here must never reject anywhere — there is no caller awaiting it — so it
   * is caught, retried, and reported through `onError` instead.
   */
  #flushFromTimer(): void {
    const state = this.#pending;
    this.#pending = null;
    if (state === null) {
      return;
    }
    const taken = (this.#taken += 1);
    this.#inFlight = this.#inFlight
      .catch(() => {})
      .then(() => writeJobState(this.#dir, state))
      .catch((reason: unknown) => {
        // Put the failed state back only if nothing newer appeared by either
        // route: a `schedule()` leaves the newer state in `#pending`, while a
        // `flush()` that took one left `#pending` null but moved `#taken` on.
        // Restoring past a newer take would write this state over its successor.
        if (this.#pending === null && this.#taken === taken) {
          this.#pending = state;
          this.#arm();
        }
        this.#onError(asError(reason));
      });
  }
}
