import { describe, expect, it, vi } from 'vitest';
import { SegmentNotifier } from '../src/download/notifier.ts';

describe('SegmentNotifier notify', () => {
  it('resolves a waiter when its segment is notified', async () => {
    const notifier = new SegmentNotifier();
    const waiting = notifier.wait(4);
    expect(notifier.waiterCount).toBe(1);

    notifier.notify(4);
    await expect(waiting).resolves.toBeUndefined();
    expect(notifier.waiterCount).toBe(0);
  });

  it('leaves waiters on other segments parked', async () => {
    const notifier = new SegmentNotifier();
    const settled = vi.fn();
    void notifier.wait(7).then(settled);

    notifier.notify(6);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).not.toHaveBeenCalled();
    expect(notifier.waiterCount).toBe(1);

    notifier.notify(7);
    await Promise.resolve();
    expect(notifier.waiterCount).toBe(0);
  });

  it('wakes every waiter on the same segment', async () => {
    const notifier = new SegmentNotifier();
    const all = Promise.all([notifier.wait(2), notifier.wait(2)]);
    expect(notifier.waiterCount).toBe(2);
    notifier.notify(2);
    await expect(all).resolves.toEqual([undefined, undefined]);
  });
});

describe('SegmentNotifier failure', () => {
  it('rejects a waiter when its signal aborts, and deregisters it', async () => {
    const notifier = new SegmentNotifier();
    const controller = new AbortController();
    const waiting = notifier.wait(1, controller.signal);

    controller.abort();
    await expect(waiting).rejects.toThrow(/abort/iu);
    expect(notifier.waiterCount).toBe(0);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const notifier = new SegmentNotifier();
    await expect(notifier.wait(1, AbortSignal.abort())).rejects.toThrow(/abort/iu);
    expect(notifier.waiterCount).toBe(0);
  });

  it('fails every waiter when the download dies', async () => {
    const notifier = new SegmentNotifier();
    const waiting = notifier.wait(3);
    notifier.rejectAll(new Error('disk full'));
    await expect(waiting).rejects.toThrow('disk full');
    expect(notifier.waiterCount).toBe(0);
  });
});
