interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

/**
 * Parks readers on a segment index and wakes them when it lands.
 *
 * Readers go through the disk, so all they ever need to know is "is segment k
 * there yet?". Keeping that a bare index — rather than a byte offset or a
 * stream — is what lets a reader detach without the fetcher noticing.
 */
export class SegmentNotifier {
  readonly #waiters = new Map<number, Set<Waiter>>();

  get waiterCount(): number {
    let total = 0;
    for (const set of this.#waiters.values()) {
      total += set.size;
    }
    return total;
  }

  /**
   * Every segment a reader is currently parked on.
   *
   * This is the fetcher's demand, and the reason it needs no second copy of
   * it: an entry appears when a reader parks and disappears when the segment
   * lands, the reader aborts, or the download dies, so the map cannot drift
   * from the set of readers actually waiting.
   */
  segments(): number[] {
    return [...this.#waiters.keys()];
  }

  wait(segment: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }

    return new Promise<void>((resolve, reject) => {
      const set = this.#waiters.get(segment) ?? new Set<Waiter>();
      this.#waiters.set(segment, set);

      const onAbort = (): void => {
        set.delete(waiter);
        if (set.size === 0) {
          this.#waiters.delete(segment);
        }
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };

      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };

      set.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  notify(segment: number): void {
    const set = this.#waiters.get(segment);
    if (set === undefined) {
      return;
    }
    this.#waiters.delete(segment);
    for (const waiter of set) {
      waiter.cleanup();
      waiter.resolve();
    }
  }

  /** Used when the download fails outright: nobody is ever getting these bytes. */
  rejectAll(error: Error): void {
    const sets = [...this.#waiters.values()];
    this.#waiters.clear();
    for (const set of sets) {
      for (const waiter of set) {
        waiter.cleanup();
        waiter.reject(error);
      }
    }
  }
}
