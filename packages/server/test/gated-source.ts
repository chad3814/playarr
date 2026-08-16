import type { ArticleBody, ArticleSource } from '@chad3814/nzb';

interface Pending {
  readonly messageId: string;
  readonly resolve: (body: ArticleBody) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Wraps an ArticleSource so a test can decide when each article arrives.
 *
 * The fetcher's interesting behaviour is all about timing — whether a seek
 * re-anchors, whether a reader parks — and that cannot be observed against a
 * source that answers instantly.
 */
export class GatedArticleSource implements ArticleSource {
  readonly #inner: ArticleSource;
  readonly #held = new Set<string>();
  readonly #failures = new Map<string, Error>();
  readonly #pending: Pending[] = [];
  readonly #requested: string[] = [];

  constructor(inner: ArticleSource) {
    this.#inner = inner;
  }

  get requested(): readonly string[] {
    return this.#requested;
  }

  get requestCount(): number {
    return this.#requested.length;
  }

  /** Later requests for this Message-ID park until `release` is called. */
  hold(messageId: string): void {
    this.#held.add(messageId);
  }

  release(messageId: string): void {
    this.#held.delete(messageId);
    const ready: Pending[] = [];
    const remaining: Pending[] = [];
    for (const entry of this.#pending) {
      (entry.messageId === messageId ? ready : remaining).push(entry);
    }
    this.#pending.length = 0;
    this.#pending.push(...remaining);
    for (const entry of ready) {
      void this.#settle(entry);
    }
  }

  /** Every request for this Message-ID rejects, as an expired article would. */
  fail(messageId: string, error: Error): void {
    this.#failures.set(messageId, error);
  }

  body(messageId: string): Promise<ArticleBody> {
    this.#requested.push(messageId);
    const failure = this.#failures.get(messageId);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    if (!this.#held.has(messageId)) {
      return this.#inner.body(messageId);
    }
    return new Promise<ArticleBody>((resolve, reject) => {
      this.#pending.push({ messageId, resolve, reject });
    });
  }

  async #settle(entry: Pending): Promise<void> {
    try {
      entry.resolve(await this.#inner.body(entry.messageId));
    } catch (error) {
      entry.reject(error as Error);
    }
  }
}
