import type { SegmentCoverage } from '../coverage/coverage.ts';
import type { FatalDownloadError } from '../download/errors.ts';
import type { ObserverOptions } from '../download/observers.ts';
import { asError, type JobErrorReporter } from './reporting.ts';
import type { JobState } from './state.ts';
import type { JobRecord, JobStore } from './store.ts';

/** Everything the bookkeeping of one running job needs. */
export interface JobProgress {
  readonly store: JobStore;
  readonly jobId: string;
  readonly coverage: SegmentCoverage;
  readonly dead: SegmentCoverage;
  readonly report: JobErrorReporter;
  /** Give up the descriptor, once the job has been marked failed. */
  readonly stop: () => Promise<void>;
}

/**
 * Record a failure the job cannot continue past.
 *
 * Takes a record rather than a JobProgress because a selection can fail before
 * there is anything to make progress on.
 */
export async function markJobFailed(
  store: JobStore,
  record: JobRecord,
  code: string,
  message: string,
): Promise<void> {
  const next: JobState = { ...record.state, status: 'failed', failure: { code, message } };
  await store.update(record.state.id, next, { flush: true });
}

/** state.json stores dead segments as indices, not as runs. */
function deadIndices(dead: SegmentCoverage): number[] {
  const indices: number[] = [];
  for (const [start, end] of dead.runs) {
    for (let index = start; index < end; index += 1) {
      indices.push(index);
    }
  }
  return indices;
}

export async function persistCoverage(
  progress: JobProgress,
  options: { flush?: boolean } = {},
): Promise<void> {
  const { store, jobId } = progress;
  const record = store.get(jobId);
  const selection = record?.state.selection;
  if (record === undefined || selection === undefined) {
    return;
  }
  await store.update(
    jobId,
    {
      ...record.state,
      selection: {
        ...selection,
        covered: progress.coverage.runs,
        dead: deadIndices(progress.dead),
      },
    },
    options,
  );
}

async function recordDrained(progress: JobProgress): Promise<void> {
  const { store, jobId } = progress;
  const record = store.get(jobId);
  if (record === undefined || record.state.status === 'complete') {
    return;
  }
  await store.update(jobId, { ...record.state, status: 'complete' }, { flush: true });
}

async function recordFatal(progress: JobProgress, error: FatalDownloadError): Promise<void> {
  const record = progress.store.get(progress.jobId);
  if (record === undefined) {
    return;
  }
  await markJobFailed(progress.store, record, error.code, error.message);
  await progress.stop();
}

/**
 * The four callbacks a Download reports through.
 *
 * Each arrow is synchronous on purpose: `JobObservers` catches a synchronous
 * throw and nothing else, so an `async` callback's rejection would escape
 * containment entirely. What the arrows launch is not synchronous — the
 * coverage write reaches the disk — so each promise carries its own catch.
 * Discarding it with `void` would turn a failed write into an unhandled
 * rejection that the guard, by construction, cannot see.
 *
 * Nothing here throws. Every one of these runs from inside the fetcher, with
 * no caller to reject to, so a failure ends at `report` or it is lost.
 */
export function jobObservers(progress: JobProgress): ObserverOptions {
  const settle = (work: Promise<void>): void => {
    work.catch((reason: unknown) => {
      progress.report(progress.jobId, asError(reason));
    });
  };

  return {
    onCoverage: () => {
      settle(persistCoverage(progress));
    },
    onDrained: () => {
      settle(recordDrained(progress));
    },
    onFatal: (error) => {
      settle(recordFatal(progress, error));
    },
    // The guard's own outlet. Nothing above can throw synchronously today, an
    // async function's failure always being a rejection, so this is what stops
    // a later edit to these arrows losing its report in silence.
    onObserverError: (error) => {
      progress.report(progress.jobId, error);
    },
  };
}
