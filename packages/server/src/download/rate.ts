/**
 * Smoothed download throughput, in bytes per second.
 *
 * Exponentially smoothed because article arrivals are bursty by construction:
 * a pool of connections lands several segments in a clump and then nothing,
 * so a rate taken from the last gap alone swings between zero and absurd.
 */
export class RateMeter {
  readonly #now: () => number;
  #bytesPerSecond = 0;
  #lastArrival: number | null = null;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get bytesPerSecond(): number {
    return Math.round(this.#bytesPerSecond);
  }

  /**
   * Note that `bytes` have arrived.
   *
   * The first arrival only starts the clock: there is no earlier arrival to
   * measure a gap against, and dividing by the time since construction would
   * report whatever the connection setup took.
   */
  record(bytes: number): void {
    const now = this.#now();
    const previous = this.#lastArrival;
    this.#lastArrival = now;
    if (previous === null) {
      return;
    }

    const seconds = (now - previous) / 1_000;
    if (seconds <= 0) {
      return;
    }

    const instant = bytes / seconds;
    this.#bytesPerSecond =
      this.#bytesPerSecond === 0 ? instant : this.#bytesPerSecond * 0.7 + instant * 0.3;
  }
}
