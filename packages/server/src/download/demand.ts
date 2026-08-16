import type { SegmentCoverage } from '../coverage/coverage.ts';
import type { SegmentNotifier } from './notifier.ts';

/**
 * Segments the fetcher writes for one anchor before it will turn to a demand
 * it is walking away from.
 *
 * Re-anchoring throws away every article in flight — up to `prefetch` of them,
 * plus the one started as the last article was consumed — so a rotation costs
 * `prefetch + 1` articles and buys `dwell` of them. At the default of four
 * connections that is five articles thrown away per sixteen written, under a
 * quarter of the bandwidth, and only while two readers genuinely persist. The
 * other side of the trade is stall: a reader waiting its turn waits a dwell,
 * around 12 MiB at the 750 KiB segments a real post uses.
 *
 * Sixteen is the smallest round number that holds that waste under a quarter
 * at the default connection count. Tune it after watching real playback: raise
 * it if contention costs throughput, lower it if the reader waiting its turn
 * stalls visibly. Raise it too if `connections` is set above sixteen, where a
 * rotation would otherwise cost more articles than it buys.
 */
export const DEMAND_DWELL_SEGMENTS = 16;

export interface DemandOptions {
  /** The waiter registry, which is the live demand and needs no mirror here. */
  readonly notifier: SegmentNotifier;
  readonly coverage: SegmentCoverage;
  readonly dead: SegmentCoverage;
  readonly prefetch: number;
}

/**
 * Which segment the fetcher should be walking towards, and nothing about how
 * it gets there.
 *
 * Demand is read off the notifier rather than remembered here. The waiter map
 * is already exactly the set of segments a reader is blocked on: it gains an
 * entry when a reader parks and loses one when the segment lands, the reader
 * aborts, or the download dies. A second copy of that set would be a thing to
 * keep in sync, and the only new behaviour it could produce is disagreeing.
 *
 * `want()`'s single slot survives as a hint — the one demand urgent enough to
 * abandon articles in flight for — but losing that hint no longer loses the
 * demand behind it. That is the whole fix: two readers can be live at once,
 * the second overwrites the first's hint, and the first is still served,
 * because the fetcher no longer believes the hint is all it knows.
 */
export class DemandPolicy {
  readonly #notifier: SegmentNotifier;
  readonly #coverage: SegmentCoverage;
  readonly #dead: SegmentCoverage;
  readonly #prefetch: number;

  #wanted: number | null = null;
  /** Segments written since the current anchor was adopted. */
  #served = 0;
  /** Whether the current anchor was taken from a reader that wanted the old one. */
  #rotated = false;
  #fillHoles = false;

  constructor(options: DemandOptions) {
    this.#notifier = options.notifier;
    this.#coverage = options.coverage;
    this.#dead = options.dead;
    this.#prefetch = Math.max(1, options.prefetch);
  }

  /** Record a demand worth abandoning articles for, judged later and elsewhere. */
  want(segment: number): void {
    this.#wanted = segment;
  }

  /**
   * Take the pending hint and make it the anchor of a fresh walk.
   *
   * Unjudged, because an idle fetcher has nothing to weigh it against — and
   * adopted, so a walk never inherits the dwell a previous one left behind.
   */
  start(): number | null {
    return this.#adopt(this.#take(), false);
  }

  /**
   * Make an exhausted walk restart from the lowest hole rather than end.
   *
   * Off by default: holes behind the anchor are deliberate, and a fetcher that
   * filled them unasked would turn `prime()` into a download of the whole
   * file. `Download.completeAll` is the one caller that needs them filled, and
   * it says why.
   */
  fillHoles(enabled: boolean): void {
    this.#fillHoles = enabled;
  }

  /**
   * Count a segment the walk has finished with under the current anchor.
   *
   * Written or given up on: a dead segment cost two article requests to
   * establish and moved the pass on just as a write does, and counting it is
   * what stops a run of expired articles holding an anchor for the length of
   * the run. See the dead branch of `SegmentFetcher.#recover`.
   */
  record(): void {
    this.#served += 1;
  }

  /**
   * Where to go from `from`, or null to carry on walking.
   *
   * A hint is a genuine seek and is honoured at once, unless this pass is
   * about to serve it anyway — re-anchoring for a segment already coming would
   * throw away the articles fetching it. Otherwise the dwell has to be spent
   * first, and whichever demand comes up then is found in the notifier: a
   * deferred demand costs latency, not the demand.
   */
  seek(from: number): number | null {
    const hint = this.#take();
    if (hint !== null && this.#honour(hint, from)) {
      return this.#adopt(hint, false);
    }
    if (this.#served < DEMAND_DWELL_SEGMENTS) {
      return null;
    }
    return this.#adopt(this.#sweep(from, this.#competing(from)), true);
  }

  /**
   * Whether to abandon the articles in flight for `hint`.
   *
   * A turn the fetcher took deliberately is not up for reconsideration until
   * the dwell that justified it has been served. Without that, the reader the
   * fetcher just turned away from strands the one it turned towards: it is
   * woken by the last segment of the old anchor, asks for the next one, and
   * that demand arrives as a hint a segment or two after the turn and takes
   * the fetcher straight back. Measured on two readers sixteen segments apart,
   * that is one re-anchor per segment written and two thirds of the articles
   * thrown away — the thrash the dwell exists to prevent, arriving by the one
   * door the dwell did not cover.
   *
   * An anchor the fetcher merely walked to, or was pointed at by a seek, has
   * nothing to protect: `prime()` fetches one segment and jumps to the tail,
   * and a dwell imposed there would fill the whole file between them.
   */
  #honour(hint: number, from: number): boolean {
    if (this.#imminent(hint, from) || this.#landed(hint)) {
      return false;
    }
    return !this.#rotated || this.#served >= DEMAND_DWELL_SEGMENTS;
  }

  /**
   * Where to go once a pass has ended, given the anchor it handed back.
   *
   * `from` is the position the pass reached, not the anchor it chose, and a
   * hint is judged against it: a demand for the segment the pass has just
   * walked past is the reader it was serving asking for the next one, not a
   * seek. Judged against the anchor instead, it would look like a seek and
   * undo a rotation in the same turn the rotation was decided — the thrash the
   * dwell exists to prevent.
   *
   * With nothing ahead and nothing in flight, any live demand will do, window
   * or not: there is no article left to throw away, and a reader parked behind
   * the anchor is the only reason to still be running.
   */
  next(returned: number | null, from: number): number | null {
    const seek = this.seek(from);
    if (seek !== null) {
      return seek;
    }
    if (returned !== null) {
      return returned;
    }
    return this.#adopt(this.#sweep(from, this.#notifier.segments()) ?? this.#lowestHole(), false);
  }

  #lowestHole(): number | null {
    return this.#fillHoles ? this.#coverage.nextHoleExcluding(0, this.#dead) : null;
  }

  #take(): number | null {
    const hint = this.#wanted;
    this.#wanted = null;
    return hint;
  }

  /** Every re-anchor starts the dwell again, whatever prompted it. */
  #adopt(anchor: number | null, rotated: boolean): number | null {
    if (anchor !== null) {
      this.#served = 0;
      this.#rotated = rotated;
    }
    return anchor;
  }

  /**
   * Demands the walk will not reach on its own before it would turn again.
   *
   * A dwell wide, not a prefetch window. The window that decides whether to
   * abandon articles for a *hint* is the prefetch depth, because that is what
   * abandoning costs; but a rotation is the fetcher choosing between two
   * demands, and the only question there is which it reaches sooner. Filtered
   * at prefetch, a demand `prefetch` segments ahead looks like a competitor:
   * the fetcher pays `prefetch + 1` articles to reach a segment the walk was
   * four away from, resets the dwell, leaves the segments it skipped as a
   * fresh hole, and strands the reader parked at `from` until the sweep wraps
   * back to it.
   *
   * What excluding a candidate buys is only that it stops being a *reason* to
   * turn. It does not pin the walk in place: with a demand behind as well, the
   * sweep finds no candidate above and wraps, so the fetcher can still rotate
   * backwards past a segment it was four away from. That is deliberate — the
   * reader behind has been waiting longer, and the one ahead is reached on the
   * way back — and it is bounded by the dwell like every other turn.
   */
  #competing(from: number): readonly number[] {
    return this.#notifier.segments().filter((segment) => !this.#nearby(segment, from));
  }

  /**
   * True when the walk gets to `segment` within the dwell it would rotate on.
   *
   * Floored at the prefetch depth, which is `connections` and has no upper
   * bound in settings. Above sixteen of those a bare dwell would be the
   * *narrower* of the two windows, readmitting candidates inside the prefetch
   * window and restoring the pathology this exists to prevent.
   */
  #nearby(segment: number, from: number): boolean {
    const reach = Math.max(this.#prefetch, DEMAND_DWELL_SEGMENTS);
    return segment >= from && segment < from + reach;
  }

  /**
   * The lowest demand above `from`, wrapping to the lowest of all.
   *
   * A clock sweep rather than the nearest demand, because nearest hands the
   * file straight back to the reader the fetcher is already next to and
   * starves the rest. Sweeping forward reaches every live demand in turn, in
   * the direction the file is read, and needs no per-reader bookkeeping to
   * decide whose turn it is.
   */
  #sweep(from: number, candidates: readonly number[]): number | null {
    let above: number | null = null;
    let lowest: number | null = null;
    for (const segment of candidates) {
      if (segment > from && (above === null || segment < above)) {
        above = segment;
      }
      if (lowest === null || segment < lowest) {
        lowest = segment;
      }
    }
    return above ?? lowest;
  }

  /** True when the pass at `from` is about to serve `segment` regardless. */
  #imminent(segment: number, from: number): boolean {
    return segment >= from && segment < from + this.#prefetch;
  }

  /**
   * True when the demand has already been met, which a hint cannot know.
   *
   * `want()` screens out a covered segment, but a reader woken by segment `k`
   * asks for `k + 1` while the article for `k + 1` is being written — coverage
   * does not admit it until the write returns — so by the time the hint is
   * judged it names bytes already on disk. Taken as a seek it re-anchors to a
   * segment the walk has passed, and since `nextHoleExcluding` then normalises
   * that straight back to where the pass already was, the only thing it
   * achieves is abandoning the articles in flight. Once per segment: measured
   * at 67 articles for a 36-segment sequential read where 37 will do. It also
   * reset the dwell often enough that no competing demand ever came up.
   */
  #landed(segment: number): boolean {
    return this.#coverage.has(segment) || this.#dead.has(segment);
  }
}
