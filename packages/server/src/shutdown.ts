import { asError } from './jobs/reporting.ts';

/**
 * The one thing `shutdown` needs from the Fastify app: somewhere to report a
 * failure, and a way to close it. Narrowed to exactly that rather than the
 * whole `FastifyInstance`, so a test can satisfy it without building one.
 */
export interface ShutdownApp {
  readonly log: {
    error(fields: { readonly err: Error }, message: string): void;
  };
  close(): Promise<void>;
}

/**
 * Every field here is narrowed to the one method `shutdown` actually calls,
 * rather than the full `JobManager`/`JobStore`/`PoolManager` classes — the
 * real classes satisfy these structurally, and a test can build a fake
 * without casting one.
 */
export interface ShutdownDeps {
  readonly manager: { releaseAll(): Promise<void> };
  readonly store: { dispose(): Promise<void> };
  readonly pool: { destroy(): Promise<void> };
  readonly app: ShutdownApp;
}

/**
 * Stop taking work and release every resource the process holds.
 *
 * `store.dispose()` rejects with an `AggregateError` naming every job whose
 * state did not reach disk. A shutdown is the one caller who can judge
 * whether that loss matters, so it is logged rather than swallowed, and a
 * non-zero exit code carries the failure to whatever is supervising this
 * process. Blocking any longer here cannot recover a write that has already
 * failed, so the rest of shutdown still runs.
 *
 * `releaseAll()` is guarded the same way, and for the sake of the line below
 * it rather than for its own: it persists a 'paused' transition through
 * `store.update(..., { flush: true })`, so a volume that has stopped
 * accepting writes fails it — and an unguarded rejection there would skip
 * `dispose()` entirely, losing the final state of every *other* job as well
 * as its own. The whole point of `dispose()` is that one unwritable job does
 * not cost the rest their state, and that has to hold from here too.
 *
 * `destroy()` and `close()` are left bare: they hold nothing durable, and
 * index.ts catches whatever they throw.
 */
export async function shutdown(deps: ShutdownDeps): Promise<void> {
  await deps.manager.releaseAll().catch((reason: unknown) => {
    deps.app.log.error({ err: asError(reason) }, 'the active job was not cleanly released');
    process.exitCode = 1;
  });
  await deps.store.dispose().catch((reason: unknown) => {
    deps.app.log.error({ err: asError(reason) }, 'job state was not fully flushed during shutdown');
    process.exitCode = 1;
  });
  await deps.pool.destroy();
  await deps.app.close();
}
