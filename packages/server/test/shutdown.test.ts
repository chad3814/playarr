import { afterEach, describe, expect, it, vi } from 'vitest';
import { shutdown, type ShutdownApp } from '../src/shutdown.ts';

type VoidResolver = () => Promise<void>;

function fakeApp(): {
  app: ShutdownApp;
  error: ReturnType<typeof vi.fn<ShutdownApp['log']['error']>>;
  close: ReturnType<typeof vi.fn<VoidResolver>>;
} {
  const error = vi.fn<ShutdownApp['log']['error']>();
  const close = vi.fn<VoidResolver>(() => Promise.resolve());
  return { app: { log: { error }, close }, error, close };
}

function fakeManager(): { manager: { releaseAll: ReturnType<typeof vi.fn<VoidResolver>> } } {
  return { manager: { releaseAll: vi.fn<VoidResolver>(() => Promise.resolve()) } };
}

function fakePool(): { pool: { destroy: ReturnType<typeof vi.fn<VoidResolver>> } } {
  return { pool: { destroy: vi.fn<VoidResolver>(() => Promise.resolve()) } };
}

function fakeStore(dispose: VoidResolver): {
  store: { dispose: ReturnType<typeof vi.fn<VoidResolver>> };
} {
  return { store: { dispose: vi.fn<VoidResolver>(dispose) } };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('shutdown - the happy path', () => {
  it('releases, disposes, destroys, and closes without touching the exit code', async () => {
    const { app, error, close } = fakeApp();
    const { manager } = fakeManager();
    const { pool } = fakePool();
    const { store } = fakeStore(() => Promise.resolve());

    await shutdown({ manager, store, pool, app });

    expect(manager.releaseAll).toHaveBeenCalledTimes(1);
    expect(store.dispose).toHaveBeenCalledTimes(1);
    expect(pool.destroy).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('shutdown - a dispose() that rejects', () => {
  it('logs the loss, sets a non-zero exit code, and still finishes shutting down', async () => {
    const { app, error, close } = fakeApp();
    const { manager } = fakeManager();
    const { pool } = fakePool();
    const failure = new AggregateError(
      [new Error('ENOSPC')],
      'job state was not flushed for: job1',
    );
    const { store } = fakeStore(() => Promise.reject(failure));

    await shutdown({ manager, store, pool, app });

    expect(error).toHaveBeenCalledTimes(1);
    const [fields, message] = error.mock.calls[0] as [{ err: Error }, string];
    expect(fields.err).toBe(failure);
    expect(message).toContain('job state was not fully flushed');
    // The loss is real, so the exit code must say so, but shutdown itself
    // still runs to completion rather than hanging or aborting early.
    expect(process.exitCode).toBe(1);
    expect(pool.destroy).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
