import type { FileHandle } from 'node:fs/promises';
import { NzbGeometryError, type NzbFileHandle } from '@chad3814/nzb';
import type { SegmentCoverage } from '../coverage/coverage.ts';
import { DemandPolicy } from './demand.ts';
import { FatalDownloadError, NON_UNIFORM_GEOMETRY } from './errors.ts';
import type { SegmentNotifier } from './notifier.ts';
import type { JobObservers } from './observers.ts';
import { RateMeter } from './rate.ts';
import { writeSegment } from './writer.ts';

// Re-exported so the fetcher's one tunable is visible where the fetcher is.
export { DEMAND_DWELL_SEGMENTS } from './demand.ts';

export interface FetcherOptions {
  readonly handle: NzbFileHandle;
  readonly fd: FileHandle;
  readonly coverage: SegmentCoverage;
  readonly dead: SegmentCoverage;
  /** Shared with the readers: notifying it is the only thing that wakes them. */
  readonly notifier: SegmentNotifier;
  readonly prefetch: number;
  /** Wrapped, so a throwing callback cannot be mistaken for a failed article. */
  readonly observers: JobObservers;
}

/**
 * The only writer of the output file: one anchored pass at a time, walking
 * forward from wherever it was last pointed. It never reads the file back and
 * knows of readers only as segment indices to notify, which is what lets a
 * reader come and go without disturbing the fetch.
 */
export class SegmentFetcher {
  readonly #handle: NzbFileHandle;
  readonly #fd: FileHandle;
  readonly #coverage: SegmentCoverage;
  readonly #dead: SegmentCoverage;
  readonly #notifier: SegmentNotifier;
  readonly #policy: DemandPolicy;
  readonly #observers: JobObservers;
  readonly #retried = new Set<number>();
  readonly #rate = new RateMeter();

  readonly #segmentSize: number;
  readonly #segmentCount: number;

  #loop: Promise<void> | null = null;
  #running = false;
  #stopped = false;
  #failure: FatalDownloadError | null = null;
  #drained = false;
  /** How far the running pass has got, which is what a demand is judged against. */
  #position = 0;

  constructor(options: FetcherOptions) {
    this.#handle = options.handle;
    this.#fd = options.fd;
    this.#coverage = options.coverage;
    this.#dead = options.dead;
    this.#notifier = options.notifier;
    this.#policy = new DemandPolicy(options);
    this.#observers = options.observers;

    const geometry = options.handle.geometry;
    this.#segmentSize = geometry.segmentSize;
    this.#segmentCount = geometry.segmentCount;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** What killed the fetch, or null if it is merely idle or stopped. */
  get failure(): FatalDownloadError | null {
    return this.#failure;
  }

  get bytesPerSecond(): number {
    return this.#rate.bytesPerSecond;
  }

  /**
   * Signal that a segment is needed. Only the demand is recorded: whether it
   * is worth re-anchoring for is decided inside the pass, at the one moment
   * the fetcher's position is known exactly. Judged here it would be compared
   * against a position that goes stale between passes, and being wrong throws
   * away every article in flight or delays the seek by a whole pass.
   *
   * The caller is expected to park on the segment straight afterwards. That
   * is not a formality: the waiter, not this slot, is what a superseded demand
   * survives in.
   */
  want(segment: number): void {
    if (this.#stopped) {
      return;
    }
    if (this.#coverage.has(segment) || this.#dead.has(segment)) {
      return;
    }
    this.#policy.want(segment);
    this.#kick();
  }

  /** See `DemandPolicy.fillHoles`. `Download.completeAll` is the only caller. */
  fillHoles(enabled: boolean): void {
    this.#policy.fillHoles(enabled);
  }

  /** Resolves once nothing further will be written, so the fd can be closed. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const loop = this.#loop;
    this.#loop = null;
    await loop?.catch(() => {});
  }

  /** Start the fetcher if it is idle and something is wanted. */
  #kick(): void {
    if (this.#stopped || this.#running) {
      return;
    }
    const anchor = this.#policy.start();
    if (anchor === null) {
      return;
    }
    this.#running = true;
    this.#loop = this.#run(anchor);
  }

  /**
   * Walk holes until there are none ahead, nothing further is wanted and
   * nobody is parked behind — or, under `fillHoles`, until there are none
   * anywhere.
   *
   * `#running` is lowered in the `finally`, which is reachable only through the
   * unbroken synchronous stretch that follows the policy's last look at the
   * hint and at the notifier. No `want()` can interleave there, and `Download`
   * registers a waiter in the same synchronous stretch as the `want()` before
   * it, so a demand is either seen by this loop or arrives to find the fetcher
   * idle and starts a new one — never neither. Nothing between that last look
   * and `#running = false` may await, or that stops being true.
   *
   * It terminates because each restart hands back a segment the next pass
   * either covers or marks dead, so the fetchable count strictly falls.
   */
  async #run(startAnchor: number): Promise<void> {
    try {
      if (!this.#handle.geometry.uniform) {
        // Left to the passes, every article would fail placement and land in
        // the dead set -- a provider that lost the post, not an unplayable one.
        this.#fail(new FatalDownloadError('non-uniform-geometry', NON_UNIFORM_GEOMETRY));
        return;
      }

      let anchor: number | null = startAnchor;
      this.#position = startAnchor;

      while (anchor !== null && !this.#stopped) {
        // Normalised every time: a demand can name a segment that landed while
        // it was queued, and a pass can hand back one already covered.
        const target = this.#coverage.nextHoleExcluding(anchor, this.#dead);
        anchor = target === null ? null : await this.#pass(target);
        anchor = this.#policy.next(anchor, this.#position);
      }
    } finally {
      this.#running = false;
    }
  }

  /** One anchored pass. Returns the next anchor, or null when there is nothing left. */
  async #pass(anchor: number): Promise<number | null> {
    let segment = anchor;
    this.#position = anchor;
    const end = this.#offsetOf(this.#holeEnd(anchor));
    const iterator = this.#handle.slice(this.#offsetOf(anchor), end)[Symbol.asyncIterator]();

    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          return this.#coverage.nextHoleExcluding(segment, this.#dead);
        }
        if (this.#stopped) {
          return null;
        }
        // Consulted with the article in hand rather than after writing it, so
        // what a seek costs does not depend on how far the pass had got.
        const seek = this.#policy.seek(segment);
        if (seek !== null) {
          return seek;
        }

        await writeSegment(this.#fd, segment, this.#offsetOf(segment), next.value);
        this.#coverage.add(segment);
        this.#retried.delete(segment);
        this.#rate.record(next.value.byteLength);
        this.#policy.record();
        this.#observers.covered(segment);
        this.#reportDrained();
        this.#notifier.notify(segment);

        segment += 1;
        this.#position = segment;
        if (this.#stopped) {
          return null;
        }
        // Again, so a seek arriving during the write need not wait out the
        // article already in flight behind it.
        const after = this.#policy.seek(segment);
        if (after !== null) {
          return after;
        }
      }
    } catch (error) {
      return this.#recover(segment, error);
    } finally {
      await iterator.return?.().catch(() => {});
    }
  }

  /**
   * One past the last segment this pass should ask for. The handle prefetches
   * ahead of what the pass consumes, so a pass allowed to run to the end of the
   * file pays for articles covering bytes already on disk.
   */
  #holeEnd(anchor: number): number {
    const boundary = (known: SegmentCoverage): number =>
      known.runs.find(([start]) => start > anchor)?.[0] ?? this.#segmentCount;
    return Math.min(boundary(this.#coverage), boundary(this.#dead));
  }

  /** Decide what a failed article means. Returns the next anchor, or null. */
  #recover(segment: number, error: unknown): number | null {
    if (error instanceof FatalDownloadError) {
      this.#fail(error);
      return null;
    }
    if (error instanceof NzbGeometryError) {
      this.#fail(
        new FatalDownloadError('non-uniform-geometry', NON_UNIFORM_GEOMETRY, { cause: error }),
      );
      return null;
    }

    // A 430 and a CRC mismatch are handled identically: try once more, then
    // accept the hole. One extra request against an expired article is cheap.
    if (!this.#retried.has(segment)) {
      this.#retried.add(segment);
      return segment;
    }

    this.#retried.delete(segment);
    this.#dead.add(segment);
    this.#observers.covered(segment);
    this.#reportDrained();
    this.#notifier.notify(segment);
    return this.#coverage.nextHoleExcluding(segment + 1, this.#dead);
  }

  /**
   * Announce that nothing fetchable is left, the instant the last segment lands
   * rather than when the loop unwinds — so a caller woken by that same segment
   * cannot see a complete file before being told it is complete.
   */
  #reportDrained(): void {
    if (this.#drained || this.#stopped) {
      return;
    }
    if (this.#coverage.nextHoleExcluding(0, this.#dead) !== null) {
      return;
    }
    this.#drained = true;
    this.#observers.drained();
  }

  #fail(error: FatalDownloadError): void {
    this.#stopped = true;
    this.#failure = error;
    // Guarded, so a throwing listener cannot skip the line below and leave
    // every parked reader waiting on a download that has already died.
    this.#observers.fatal(error);
    this.#notifier.rejectAll(error);
  }

  #offsetOf(segment: number): number {
    return segment * this.#segmentSize;
  }
}
