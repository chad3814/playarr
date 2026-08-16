/**
 * Where a job's background failures go.
 *
 * Everything routed here happens behind an observer or inside a promise the
 * fetcher launched, so there is no caller to reject to and no request to fail.
 * Task 13 wires real logging and replaces this wholesale; until then this is
 * the whole of it.
 */

/** Told about a failure that has no caller to reject to. */
export type JobErrorReporter = (jobId: string, error: Error) => void;

/**
 * The default destination.
 *
 * Deliberately not a no-op. A swallowed report leaves a job that has quietly
 * stopped recording its own progress looking healthy, and one line on stderr
 * is what an operator can actually find. `JobManager`'s constructor parameter
 * is the seam Task 13 replaces.
 */
export function reportToStderr(jobId: string, error: Error): void {
  process.stderr.write(`playarr: job ${jobId}: ${error.stack ?? error.message}\n`);
}

/** Normalise a rejection reason, which is `unknown` and need not be an Error. */
export function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
