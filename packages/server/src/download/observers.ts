import type { FatalDownloadError } from './errors.ts';

export interface ObserverOptions {
  /** Which segment just landed, so the job can persist its coverage. */
  readonly onCoverage: (segment: number) => void;
  /** Raised once, when no fetchable segment is left. */
  readonly onDrained: () => void;
  readonly onFatal: (error: FatalDownloadError) => void;
  /**
   * Raised when one of the three above threw.
   *
   * Not optional. The point of catching an observer's failure is to keep the
   * download alive, and a job that has quietly stopped being able to record
   * its own progress must not also look healthy.
   */
  readonly onObserverError: (error: Error) => void;
}

/**
 * The job's callbacks, invoked so a throw from one is never mistaken for a
 * failed article.
 *
 * The fetcher runs these from inside the same `try` that catches article
 * errors, and unguarded that is actively destructive rather than merely
 * untidy: a throwing `onCoverage` is recovered from as though the *article*
 * had failed, so the segment is re-requested despite already being on disk,
 * and on the second throw a good, fully written segment is added to the dead
 * set. Nothing here is made fatal, because the bytes reached the descriptor
 * either way and coverage is cumulative — the next segment to land re-states
 * everything the dropped call would have said.
 */
export class JobObservers {
  readonly #options: ObserverOptions;

  constructor(options: ObserverOptions) {
    this.#options = options;
  }

  covered(segment: number): void {
    this.#guard(() => this.#options.onCoverage(segment));
  }

  drained(): void {
    this.#guard(() => this.#options.onDrained());
  }

  fatal(error: FatalDownloadError): void {
    this.#guard(() => this.#options.onFatal(error));
  }

  #guard(observe: () => void): void {
    try {
      observe();
    } catch (error) {
      this.#report(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #report(error: Error): void {
    try {
      this.#options.onObserverError(error);
    } catch {
      // An error handler that throws has nowhere left to report to. Swallowing
      // it is the only option that still leaves the download running.
    }
  }
}
