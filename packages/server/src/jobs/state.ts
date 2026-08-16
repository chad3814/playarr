import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JobStateError, parseJobState, STATE_FILENAME, type JobState } from './state-parse.ts';

/**
 * The whole of a job's persisted state lives behind this module: reading and
 * validating it (`./state-parse.ts`), writing it, and coalescing those writes.
 *
 * Split only because the reading half and the writing half had grown to fill
 * one file's line budget between them, which left the most delicate code in
 * the project with no room for its next change. The seam is deliberate rather
 * than arbitrary — parsing is pure and total, writing is stateful and
 * concurrent — but every importer still goes through `state.ts`, so nothing
 * outside has to know the split happened.
 */
export {
  JobStateError,
  parseJobState,
  STATE_FILENAME,
  type JobGeometry,
  type JobSelection,
  type JobState,
} from './state-parse.ts';

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
   * this returns.
   *
   * Two things this does *not* promise, both of which need a second caller to
   * observe:
   *
   * - It assumes it is the only flush in progress. Two concurrent `flush()`
   *   calls both awaiting a failing timer write will both be released by its
   *   catch handler; the first re-check takes the restored state and writes
   *   it, and the second then finds `#pending` null and returns — resolving
   *   while the write that carries its own state is still in flight.
   * - Each pass awaits the `#inFlight` it read, not whatever `#inFlight`
   *   became afterwards, so a write chained on by someone else mid-flush is
   *   likewise not waited for.
   *
   * `JobStore` never has two flushes outstanding for one job today — `update`
   * and `dispose` are both awaited by their callers — so this is a limit of
   * the contract rather than a live defect. Anything that starts flushing one
   * writer from two places at once needs a lock here first.
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
        //
        // Both halves are load-bearing, and no single test covers the pair:
        //   - state.test.ts, 'JobStateWriter - retries a failed timer-driven
        //     write' and 'JobStateWriter - onError defaults' pin that a lone
        //     failure *does* restore and re-arm. Drop the restore and the
        //     state is lost.
        //   - state.test.ts, 'JobStateWriter - supersession of a failed retry'
        //     pins `#pending === null`: a newer state scheduled while this
        //     write hung must not be overwritten by it.
        //   - shutdown-durability.test.ts, 'JobStateWriter.flush - a superseded
        //     state must never be written last' pins `#taken === taken`: a
        //     newer state *taken by a flush* leaves `#pending` null too, so
        //     `#pending` alone cannot tell that case from "nothing happened".
        if (this.#pending === null && this.#taken === taken) {
          this.#pending = state;
          this.#arm();
        }
        this.#onError(asError(reason));
      });
  }
}
