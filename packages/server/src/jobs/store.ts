import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseNzb, type Nzb } from '@chad3814/nzb-parser';
import {
  JobStateError,
  JobStateWriter,
  readJobState,
  writeJobState,
  type JobState,
} from './state.ts';

export const NZB_FILENAME = 'source.nzb';

export interface JobRecord {
  state: JobState;
  readonly dir: string;
  /** Parsed once and held, so listing jobs never re-parses. */
  readonly nzb: Nzb;
  readonly writer: JobStateWriter;
}

/**
 * Owns the on-disk layout of jobs and nothing else.
 *
 * A job is a directory rather than a database row, so everything about it is
 * visible with `ls` and removable with `rm -r`.
 */
export class JobStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #onWriteError: (jobId: string, error: Error) => void;
  readonly #records = new Map<string, JobRecord>();

  constructor(
    root: string,
    now: () => Date = () => new Date(),
    id: () => string = randomUUID,
    onWriteError: (jobId: string, error: Error) => void = () => {},
  ) {
    this.#root = root;
    this.#now = now;
    this.#id = id;
    this.#onWriteError = onWriteError;
  }

  list(): JobRecord[] {
    return [...this.#records.values()].toSorted((a, b) =>
      a.state.createdAt < b.state.createdAt ? 1 : -1,
    );
  }

  get(id: string): JobRecord | undefined {
    return this.#records.get(id);
  }

  /**
   * The single choke point every later task uses to open the video file.
   *
   * `selection.name` is only validated by `parseJobState` as a non-empty
   * string, and `state.json` lives on the user's volume, so a hand-edited or
   * corrupted file must not be able to steer a write outside the job
   * directory. A name that isn't already its own basename is rejected
   * outright rather than coerced: coercion would mean silently writing to a
   * different path than the file that actually exists on disk.
   */
  outputPath(record: JobRecord): string {
    const name = record.state.selection?.name;
    if (name === undefined) {
      throw new Error(`job ${record.state.id} has no selected file`);
    }
    if (
      name === '' ||
      name === '.' ||
      name === '..' ||
      name.includes('\\') ||
      basename(name) !== name
    ) {
      throw new Error(
        `job ${record.state.id} has an unsafe selection name: ${JSON.stringify(name)}`,
      );
    }
    return join(record.dir, name);
  }

  async create(nzbName: string, bytes: Buffer): Promise<JobRecord> {
    const text = bytes.toString('utf8');
    // Parse before touching the disk: a malformed NZB must not leave a directory.
    const nzb = parseNzb(text);

    const id = this.#id();
    const dir = join(this.#root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, NZB_FILENAME), text, 'utf8');

    const state: JobState = {
      id,
      createdAt: this.#now().toISOString(),
      nzbName,
      status: 'uploaded',
    };
    await writeJobState(dir, state);

    const writer = this.#makeWriter(dir, id);
    const record: JobRecord = { state, dir, nzb, writer };
    this.#records.set(id, record);
    return record;
  }

  /**
   * Replace a record's state. `flush` forces an immediate write and must be
   * used for every status transition; coverage updates may ride the debounce.
   */
  async update(id: string, next: JobState, options: { flush?: boolean } = {}): Promise<void> {
    const record = this.#records.get(id);
    if (record === undefined) {
      throw new Error(`no such job: ${id}`);
    }
    record.state = next;
    record.writer.schedule(next);
    if (options.flush === true) {
      await record.writer.flush();
    }
  }

  async remove(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (record === undefined) {
      return;
    }
    this.#records.delete(id);
    // Dispose to stop the debounce and let go of the pending state, but do not
    // gate the removal on it succeeding. The only thing that dispose can fail
    // at here is writing state.json into the directory the next line deletes,
    // so the failure is moot; letting it propagate would strand a directory
    // whose record is already gone, and nothing would ever come back for it.
    // A rejected dispose still leaves the writer quiescent, so nothing keeps
    // retrying against the deleted directory: the only handler that re-arms
    // the debounce is the timer path's, and it re-arms only when its own write
    // was the writer's most recent take — which a flush that took a newer
    // state, as this one does, is not.
    await record.writer.dispose().catch(() => {});
    await rm(record.dir, { recursive: true, force: true });
  }

  /** Rebuild the index from disk. Nothing resumes; jobs come back paused. */
  async scan(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const entries = await readdir(this.#root, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      await this.#scanEntry(entry.name);
    }
  }

  /**
   * Every writer gets its chance to flush before any failure is raised.
   * `Promise.all` would settle on the first rejection, so one job with an
   * unwritable directory would leave the shutdown free to exit while every
   * other job's final write was still in flight — a wider version of the loss
   * this dispose exists to prevent — and it would discard all but one of the
   * failures.
   *
   * The failures are raised rather than routed to `onWriteError`, which is for
   * the background timer path that has no caller to tell. A shutdown does have
   * one, and it is the only party that can decide whether losing this state is
   * fatal, so it is given every failure at once instead of one of them.
   */
  async dispose(): Promise<void> {
    const failures = new Map<string, Error>();
    await Promise.all(
      [...this.#records.entries()].map(async ([id, record]) => {
        try {
          await record.writer.dispose();
        } catch (error) {
          failures.set(id, error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );
    if (failures.size === 0) {
      return;
    }
    // Reported in record order rather than in the order the failures happened
    // to land, so the same set of unwritable jobs always reads the same way.
    const lost = [...this.#records.keys()].flatMap((id) => {
      const error = failures.get(id);
      return error === undefined ? [] : [{ id, error }];
    });
    throw new AggregateError(
      lost.map((entry) => entry.error),
      `job state was not flushed for: ${lost.map((entry) => entry.id).join(', ')}`,
    );
  }

  async #scanEntry(name: string): Promise<void> {
    const dir = join(this.#root, name);

    let nzb: Nzb;
    try {
      const text = await readFile(join(dir, NZB_FILENAME), 'utf8');
      nzb = parseNzb(text);
    } catch {
      // Not a job directory, or an NZB we can no longer read.
      return;
    }

    const writer = this.#makeWriter(dir, name);
    const state = await this.#loadState(dir, name);
    this.#records.set(name, { state, dir, nzb, writer });
  }

  async #loadState(dir: string, name: string): Promise<JobState> {
    try {
      const loaded = await readJobState(dir);
      // A live fetcher never survives a restart, so nothing is active.
      return loaded.status === 'ready' ? { ...loaded, status: 'paused' } : loaded;
    } catch (error) {
      const reason = error instanceof JobStateError ? error.message : String(error);
      return {
        id: name,
        // Nothing about this job is known: state.json is what carried the
        // upload's name and time, and state.json is the file that cannot be
        // read. The epoch is a placeholder no real job can hold, and the
        // directory name is at least true -- `NZB_FILENAME` here rendered in
        // the UI as a plausible upload called "source.nzb", which is a claim
        // this record has no basis for making.
        createdAt: new Date(0).toISOString(),
        nzbName: name,
        status: 'failed',
        failure: {
          code: 'corrupt-state',
          message: `state.json is unreadable, so which bytes on disk are real is unknowable: ${reason}`,
        },
      };
    }
  }

  #makeWriter(dir: string, id: string): JobStateWriter {
    return new JobStateWriter(dir, undefined, (error) => this.#onWriteError(id, error));
  }
}
