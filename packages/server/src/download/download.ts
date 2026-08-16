import type { FileHandle } from 'node:fs/promises';
import type { NzbFileHandle } from '@chad3814/nzb';
import { coveredBytes } from '@playarr/shared';
import type { SegmentCoverage } from '../coverage/coverage.ts';
import { FatalDownloadError } from './errors.ts';
import { SegmentFetcher } from './fetcher.ts';
import { SegmentNotifier } from './notifier.ts';
import { JobObservers, type ObserverOptions } from './observers.ts';

export { FatalDownloadError };

export interface DownloadOptions extends ObserverOptions {
  readonly handle: NzbFileHandle;
  readonly fd: FileHandle;
  readonly coverage: SegmentCoverage;
  readonly dead: SegmentCoverage;
  readonly prefetch: number;
}

/**
 * Owns the active job: one fetcher writing a sparse file, and any number of
 * readers reading it back.
 *
 * Readers never touch the fetch stream. They read from disk and park on a
 * segment index, which is what makes a backwards seek free and what lets an
 * aborted HTTP response leave the download running.
 */
export class Download {
  /**
   * Public because the descriptor is the job's, not this object's: the caller
   * opened it and closes it, and is entitled to see it.
   */
  readonly fd: FileHandle;

  readonly #coverage: SegmentCoverage;
  readonly #dead: SegmentCoverage;
  readonly #notifier = new SegmentNotifier();
  readonly #fetcher: SegmentFetcher;

  readonly #size: number;
  readonly #segmentSize: number;
  readonly #lastSegmentSize: number;
  readonly #segmentCount: number;

  constructor(options: DownloadOptions) {
    this.fd = options.fd;
    this.#coverage = options.coverage;
    this.#dead = options.dead;
    this.#size = options.handle.size;

    const geometry = options.handle.geometry;
    this.#segmentSize = geometry.segmentSize;
    this.#lastSegmentSize = geometry.lastSegmentSize;
    this.#segmentCount = geometry.segmentCount;

    this.#fetcher = new SegmentFetcher({
      ...options,
      notifier: this.#notifier,
      observers: new JobObservers(options),
    });
  }

  get coverage(): SegmentCoverage {
    return this.#coverage;
  }

  get dead(): SegmentCoverage {
    return this.#dead;
  }

  get size(): number {
    return this.#size;
  }

  get segmentCount(): number {
    return this.#segmentCount;
  }

  get bytesPerSecond(): number {
    return this.#fetcher.bytesPerSecond;
  }

  get coveredBytes(): number {
    return coveredBytes(this.#coverage.runs, {
      segmentSize: this.#segmentSize,
      lastSegmentSize: this.#lastSegmentSize,
      segmentCount: this.#segmentCount,
    });
  }

  /**
   * Fetch the first and last segments.
   *
   * An MP4's `moov` atom sits at the front on a faststart encode and at the
   * back on most remuxes, and the NZB cannot say which. Segment 1 was already
   * paid for by `openNzbFile` and is cached, so this usually costs one article.
   */
  async prime(): Promise<void> {
    this.want(0);
    await this.waitFor(0);
    const last = this.#segmentCount - 1;
    if (last > 0) {
      this.want(last);
      await this.waitFor(last);
    }
  }

  /** Point the fetcher at a segment. Cheap, and safe to call for one it has. */
  want(segment: number): void {
    this.#fetcher.want(segment);
  }

  waitFor(segment: number, signal?: AbortSignal): Promise<void> {
    if (this.#coverage.has(segment) || this.#dead.has(segment)) {
      return Promise.resolve();
    }
    if (this.#fetcher.stopped) {
      // Nothing will ever notify this segment, so parking on it would hang.
      return Promise.reject(this.#stoppedError());
    }
    return this.#notifier.wait(segment, signal);
  }

  /** Fill every hole the provider still has. Used by the download-to-disk step. */
  async completeAll(): Promise<void> {
    let target = this.#coverage.nextHoleExcluding(0, this.#dead);
    while (target !== null && !this.#fetcher.stopped) {
      this.want(target);
      await this.waitFor(target);
      target = this.#coverage.nextHoleExcluding(0, this.#dead);
    }
  }

  /**
   * Read `[start, end)`, fetching whatever is not yet on disk.
   *
   * A dead segment is read like any other, which yields the zeros the sparse
   * file holds. The player gets a few seconds of garbage instead of a response
   * that never ends.
   */
  async *read(start: number, end: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    let position = Math.max(0, start);
    const limit = Math.min(end, this.#size);

    while (position < limit) {
      const segment = Math.floor(position / this.#segmentSize);
      if (!this.#coverage.has(segment) && !this.#dead.has(segment)) {
        this.want(segment);
        await this.waitFor(segment, signal);
      }

      // The last segment is short, but the file ends with it, so clamping to
      // `limit` handles the tail without a separate case.
      const segmentEnd = Math.min(limit, (segment + 1) * this.#segmentSize);
      const length = segmentEnd - position;
      const buffer = Buffer.alloc(length);
      await this.fd.read(buffer, 0, length, position);
      yield buffer;
      position = segmentEnd;
    }
  }

  /** Stop fetching and fail every parked reader. The fd is the caller's to close. */
  async stop(): Promise<void> {
    await this.#fetcher.stop();
    this.#notifier.rejectAll(this.#stoppedError());
  }

  #stoppedError(): Error {
    return this.#fetcher.failure ?? new Error('download stopped');
  }
}
