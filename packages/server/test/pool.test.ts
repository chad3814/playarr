import { describe, expect, it, vi } from 'vitest';
import {
  NotConfiguredError,
  PoolManager,
  type PoolFactory,
  type PoolLike,
} from '../src/nntp/pool.ts';
import type { ResolvedSettings } from '../src/config/settings.ts';

const settings: ResolvedSettings = {
  host: 'news.example.com',
  port: 563,
  security: 'implicit',
  connections: 8,
  username: 'someone',
};

function fakePool(overrides: Partial<PoolLike> = {}): PoolLike {
  return {
    body: vi.fn(() => Promise.resolve({ body: Buffer.alloc(0) })),
    destroy: vi.fn(() => {}),
    failures: [],
    ...overrides,
  };
}

/** Lets a rejected promise's unhandled-rejection check run before asserting. */
function afterMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('PoolManager configuration lifecycle', () => {
  it('reports itself unconfigured before configure is called', () => {
    const manager = new PoolManager(() => fakePool());
    expect(manager.isConfigured()).toBe(false);
    expect(() => manager.source()).toThrow(NotConfiguredError);
  });

  it('builds a pool from the settings it is given', () => {
    const factory = vi.fn<PoolFactory>(() => fakePool());
    const manager = new PoolManager(factory);
    manager.configure(settings, { user: 'someone', pass: 'secret' });

    expect(manager.isConfigured()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    const options = factory.mock.calls[0]![0];
    expect(options.endpoint).toEqual({ host: 'news.example.com', port: 563, security: 'implicit' });
    expect(options.connections).toBe(8);
  });

  it('destroys the previous pool when reconfigured', () => {
    const first = fakePool();
    const second = fakePool();
    let call = 0;
    const manager = new PoolManager(() => (call++ === 0 ? first : second));

    manager.configure(settings, { user: 'a', pass: 'b' });
    manager.configure({ ...settings, host: 'other.example.com' }, { user: 'a', pass: 'b' });

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).not.toHaveBeenCalled();
  });

  it('destroys the live pool on shutdown', async () => {
    const pool = fakePool();
    const manager = new PoolManager(() => pool);
    manager.configure(settings, { user: 'a', pass: 'b' });
    await manager.destroy();
    expect(pool.destroy).toHaveBeenCalledTimes(1);
    expect(manager.isConfigured()).toBe(false);
  });
});

describe('PoolManager reconfiguration cleanup failures: synchronous throw', () => {
  it('swaps to the new pool without throwing when the previous pool destroy() throws synchronously', () => {
    const first = fakePool({
      destroy: vi.fn(() => {
        throw new Error('destroy boom');
      }),
    });
    const second = fakePool();
    let call = 0;
    const manager = new PoolManager(() => (call++ === 0 ? first : second));

    manager.configure(settings, { user: 'a', pass: 'b' });
    expect(() =>
      manager.configure({ ...settings, host: 'other.example.com' }, { user: 'a', pass: 'b' }),
    ).not.toThrow();

    expect(manager.isConfigured()).toBe(true);
    expect(manager.source()).toBe(second);
  });
});

describe('PoolManager reconfiguration cleanup failures: rejected promise', () => {
  it('swaps to the new pool without an unhandled rejection when the previous pool destroy() rejects', async () => {
    // A plain function, not `vi.fn()`: vitest's mock wrapper attaches its own
    // `.then(onFulfilled, onRejected)` to any promise a mock returns, purely
    // to record `mock.settledResults` — which itself counts as "handled" for
    // Node's unhandled-rejection detection regardless of what the caller
    // does. Only a bare rejecting promise proves this test would fail
    // without the fix in `configure()`.
    let destroyCalled = false;
    const first = fakePool({
      destroy: () => {
        destroyCalled = true;
        return Promise.reject(new Error('destroy boom'));
      },
    });
    const second = fakePool();
    let call = 0;
    const manager = new PoolManager(() => (call++ === 0 ? first : second));

    const onUnhandledRejection = vi.fn();
    process.on('unhandledRejection', onUnhandledRejection);

    manager.configure(settings, { user: 'a', pass: 'b' });
    manager.configure({ ...settings, host: 'other.example.com' }, { user: 'a', pass: 'b' });

    await afterMicrotasks();
    await afterMicrotasks();
    process.off('unhandledRejection', onUnhandledRejection);

    expect(destroyCalled).toBe(true);
    expect(onUnhandledRejection).not.toHaveBeenCalled();
    expect(manager.isConfigured()).toBe(true);
    expect(manager.source()).toBe(second);
  });
});

describe('PoolManager connection probe', () => {
  it('reports success when a probe article request reaches the server', async () => {
    const manager = new PoolManager(() =>
      fakePool({ body: vi.fn(() => Promise.resolve({ body: Buffer.from('ok') })) }),
    );
    manager.configure(settings, { user: 'a', pass: 'b' });
    await expect(manager.test()).resolves.toEqual({
      ok: true,
      message: 'Connected to news.example.com:563.',
      failures: [],
    });
  });

  it('surfaces the pool per-attempt failures, so a connection cap is visible', async () => {
    const manager = new PoolManager(() =>
      fakePool({ failures: [{ at: 0, reason: '502 Too many connections' }] }),
    );
    manager.configure(settings, { user: 'a', pass: 'b' });
    const result = await manager.test();
    expect(result.failures).toEqual(['502 Too many connections']);
  });

  it('treats a 430 on the probe as success, because it proves authentication worked', async () => {
    const notFound = Object.assign(new Error('430 No such article'), { status: 430 });
    const manager = new PoolManager(() =>
      fakePool({ body: vi.fn(() => Promise.reject(notFound)) }),
    );
    manager.configure(settings, { user: 'a', pass: 'b' });
    const result = await manager.test();
    expect(result.ok).toBe(true);
  });

  it('reports a failure message without echoing the credential', async () => {
    const authError = new Error('481 Authentication failed');
    const manager = new PoolManager(() =>
      fakePool({ body: vi.fn(() => Promise.reject(authError)) }),
    );
    manager.configure(settings, { user: 'a', pass: 'hunter2' });

    const result = await manager.test();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('481');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('reports unconfigured rather than throwing from test()', async () => {
    const manager = new PoolManager(() => fakePool());
    await expect(manager.test()).resolves.toMatchObject({ ok: false });
  });
});
