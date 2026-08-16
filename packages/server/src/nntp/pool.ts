import {
  NntpPool,
  type NntpConnectionFailure,
  type NntpPoolOptions,
  type NntpSecret,
} from '@chad3814/nntp';
import type { ArticleSource } from '@chad3814/nzb';
import type { SettingsTestResult } from '@playarr/shared';
import type { ResolvedSettings } from '../config/settings.ts';

/**
 * The part of NntpPool this app uses. Narrow so tests need no socket.
 *
 * `NntpPool` satisfies this structurally, so the default factory needs no cast:
 * `body()` returns an `NntpArticleResponse`, which carries the `body: Buffer`
 * that `ArticleSource` requires, and `destroy()` is synchronous `void`.
 */
export interface PoolLike extends ArticleSource {
  destroy(): Promise<void> | void;
  readonly failures: readonly NntpConnectionFailure[];
}

export type PoolFactory = (options: NntpPoolOptions) => PoolLike;

export class NotConfiguredError extends Error {
  readonly code = 'not-configured';

  constructor() {
    super('No Usenet provider is configured. Set NNTP_HOST or use the settings page.');
    this.name = 'NotConfiguredError';
  }
}

/** A Message-ID that will not exist. A 430 answer still proves we authenticated. */
const PROBE_MESSAGE_ID = 'playarr-connection-probe@invalid';

export class PoolManager {
  readonly #factory: PoolFactory;
  #pool: PoolLike | null = null;
  #description = '';
  #connections = 0;

  constructor(factory: PoolFactory = (options) => new NntpPool(options)) {
    this.#factory = factory;
  }

  isConfigured(): boolean {
    return this.#pool !== null;
  }

  source(): ArticleSource {
    if (this.#pool === null) {
      throw new NotConfiguredError();
    }
    return this.#pool;
  }

  /** Drives both the pool size and the fetcher's prefetch depth. */
  get connections(): number {
    return this.#connections;
  }

  #failureMessages(): string[] {
    // NntpConnectionFailure is a plain record, not an Error: `{ at, reason }`.
    return (this.#pool?.failures ?? []).map((failure) => failure.reason);
  }

  configure(settings: ResolvedSettings, credentials: { user: NntpSecret; pass: NntpSecret }): void {
    const previous = this.#pool;
    this.#pool = this.#factory({
      endpoint: { host: settings.host, port: settings.port, security: settings.security },
      credentials,
      connections: settings.connections,
    });
    this.#connections = settings.connections;
    this.#description = `${settings.host}:${settings.port}`;
    // Destroyed after the replacement exists, so a failed construction leaves
    // the working pool in place. The swap above has already happened by the
    // time this runs, so a failure here — thrown synchronously or a rejected
    // promise — must not propagate: it would either surface as an unhandled
    // rejection or make configure() throw after it already succeeded. A
    // logger exists elsewhere in this codebase now, but PoolManager has none
    // of its own, and giving it one would mean changing this constructor —
    // no caller has needed that yet, so the failure is still deliberately
    // discarded here rather than reported.
    try {
      void Promise.resolve(previous?.destroy()).catch(() => {
        // Discarded — see the comment above.
      });
    } catch {
      // Discarded — see the comment above.
    }
  }

  /**
   * Fetch one article that cannot exist. A 430 is a success: the request was
   * accepted, which means the connection opened and AUTHINFO was accepted.
   */
  async test(): Promise<SettingsTestResult> {
    if (this.#pool === null) {
      return { ok: false, message: new NotConfiguredError().message, failures: [] };
    }
    try {
      await this.#pool.body(PROBE_MESSAGE_ID);
      return {
        ok: true,
        message: `Connected to ${this.#description}.`,
        failures: this.#failureMessages(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b430\b/u.test(message)) {
        return {
          ok: true,
          message: `Connected to ${this.#description}.`,
          failures: this.#failureMessages(),
        };
      }
      return { ok: false, message, failures: this.#failureMessages() };
    }
  }

  async destroy(): Promise<void> {
    const pool = this.#pool;
    this.#pool = null;
    this.#connections = 0;
    await pool?.destroy();
  }
}
