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

describe('SegmentNotifier segments', () => {
  it('reports exactly the segments a reader is parked on', async () => {
    const notifier = new SegmentNotifier();
    expect(notifier.segments()).toEqual([]);

    const waiting = Promise.all([notifier.wait(5), notifier.wait(2), notifier.wait(5)]);
    expect(notifier.segments().toSorted((a, b) => a - b)).toEqual([2, 5]);

    notifier.notify(5);
    expect(notifier.segments()).toEqual([2]);
    notifier.notify(2);
    expect(notifier.segments()).toEqual([]);
    await waiting;
  });

  it('drops a segment as soon as its last waiter aborts', async () => {
    const notifier = new SegmentNotifier();
    const controller = new AbortController();
    const staying = notifier.wait(9);
    const going = notifier.wait(9, controller.signal);

    controller.abort();
    await expect(going).rejects.toThrow(/abort/iu);
    expect(notifier.segments()).toEqual([9]);

    notifier.notify(9);
    await staying;
    expect(notifier.segments()).toEqual([]);
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
