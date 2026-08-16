import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collect,
  EIGHT,
  flush,
  harness,
  messageIds,
  SEG,
  type Harness,
} from './download-harness.ts';

let openHarness: Harness | null = null;

afterEach(async () => {
  await openHarness?.close();
  openHarness = null;
});

describe('Download completion', () => {
  it('reports drained once every fetchable segment is on disk', async () => {
    const h = (openHarness = await harness([SEG, SEG, 400]));
    await h.download.completeAll();
    expect(h.download.coverage.isComplete()).toBe(true);
    expect(h.onDrained).toHaveBeenCalledTimes(1);
  });

  it('completes even when a segment is permanently dead', async () => {
    const h = (openHarness = await harness([SEG, SEG, 400]));
    const ids = messageIds(h);
    h.source.fail(ids[1]!, new Error('430 No such article'));

    await h.download.completeAll();
    expect(h.download.dead.has(1)).toBe(true);
    expect(h.download.coverage.has(0)).toBe(true);
    expect(h.download.coverage.has(2)).toBe(true);
    expect(h.onDrained).toHaveBeenCalledTimes(1);
  });
});

/**
 * Park the fetcher mid-file with the tail already covered, so that whatever
 * re-anchors it next runs straight out of holes ahead and exhausts.
 *
 * Returns the harness with segment 7 covered, segment 2's article held, and a
 * `completeAll()` in flight that has reached segment 2 and is waiting on it.
 */
async function stalledCompletion(): Promise<{
  readonly h: Harness;
  readonly ids: readonly string[];
  readonly completing: Promise<void>;
}> {
  const h = (openHarness = await harness(EIGHT));
  const ids = messageIds(h);
  h.download.want(7);
  await h.download.waitFor(7);

  h.source.hold(ids[2]!);
  const completing = h.download.completeAll();
  await vi.waitFor(() => expect(h.download.coverage.has(1)).toBe(true));
  // A whole turn, so completeAll's own want(2) has certainly been issued and
  // taken. Anything wanted after this really is superseding it.
  await flush();
  return { h, ids, completing };
}

describe('Download.completeAll against a reader that re-anchors past it', () => {
  it('finishes rather than waiting forever on the hole it was left behind', async () => {
    const { h, ids, completing } = await stalledCompletion();

    // The Player keeps the <video> mounted behind the finished dialog, so a
    // range request lands mid-fill and re-anchors the fetcher to segment 5 --
    // past the segment 2 that completeAll is parked on. From 5 the walk covers
    // 5 and 6, meets the tail, and runs out of holes ahead of it.
    const reading = collect(h.download.read(5 * SEG, 6 * SEG));
    h.source.release(ids[2]!);

    await completing;
    expect((await reading).equals(h.post.data.subarray(5 * SEG, 6 * SEG))).toBe(true);
    expect(h.download.coverage.isComplete()).toBe(true);
    expect(h.onDrained).toHaveBeenCalledTimes(1);
  });

  it('serves a reader parked behind the demand that superseded it', async () => {
    const { h, ids, completing } = await stalledCompletion();

    // Two readers, in this order: the first parks on segment 2, the second
    // supersedes its demand and sends the fetcher to the far end. Only one
    // seek is ever live, so the first is left parked on a segment nothing is
    // walking towards.
    const stranded = collect(h.download.read(2 * SEG, 3 * SEG));
    const far = collect(h.download.read(5 * SEG, 6 * SEG));
    h.source.release(ids[2]!);

    expect((await stranded).equals(h.post.data.subarray(2 * SEG, 3 * SEG))).toBe(true);
    expect((await far).equals(h.post.data.subarray(5 * SEG, 6 * SEG))).toBe(true);
    await completing;
  });
});
