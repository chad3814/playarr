import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMAND_DWELL_SEGMENTS } from '../src/download/fetcher.ts';
import { collect, EIGHT, flush, harness, LONG, SEG, type Harness } from './download-harness.ts';

let openHarness: Harness | null = null;

afterEach(async () => {
  await openHarness?.close();
  openHarness = null;
});

/** Exactly the segments the fetcher wrote, in the order it wrote them. */
function writeOrder(h: Harness): number[] {
  return h.onCoverage.mock.calls.map(([segment]) => segment);
}

/** A reader of segments `[from, to)`, started at once, as a range request is. */
function reader(h: Harness, from: number, to: number): Promise<Buffer> {
  return collect(h.download.read(from * SEG, to * SEG));
}

function segmentsOf(h: Harness, from: number, to: number): Buffer {
  return h.post.data.subarray(from * SEG, to * SEG);
}

function run(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

describe('Download demand', () => {
  it('serves a reader whose demand a later one superseded', async () => {
    const h = (openHarness = await harness(EIGHT));
    // What a <video> does on a seek: a second range request lands while the
    // first is still parked, so two demands are live at once and only the
    // later one ever reached the fetcher's single slot.
    const stranded = reader(h, 2, 3);
    const far = reader(h, 5, 6);

    // The far reader is the one the fetcher re-anchored for, so it is served
    // and the walk then runs off the end of the file. Nothing points the
    // fetcher back at segment 2 -- nothing but the reader still parked on it.
    expect((await far).equals(segmentsOf(h, 5, 6))).toBe(true);
    expect((await stranded).equals(segmentsOf(h, 2, 3))).toBe(true);
  });

  it('leaves the middle of the file alone when nobody is parked in it', async () => {
    const h = (openHarness = await harness(LONG));
    await h.download.prime();
    await flush();

    // The canary for reading demand off the notifier: a fetcher that treated
    // "out of holes ahead" as licence to fill holes behind would turn every
    // selection into a download of the whole file.
    expect(h.download.coverage.runs).toEqual([
      [0, 1],
      [39, 40],
    ]);
  });
});

describe('Download demand against a parked reader', () => {
  it('holds the anchor for a whole dwell before turning back to it', async () => {
    const h = (openHarness = await harness(LONG));
    const stranded = reader(h, 4, 5);
    const far = reader(h, 8, 9);

    expect((await far).equals(segmentsOf(h, 8, 9))).toBe(true);
    expect((await stranded).equals(segmentsOf(h, 4, 5))).toBe(true);

    // Pinned on both sides. One short of the dwell is thrash; never turning
    // is the starvation this policy exists to end. The turn is backwards,
    // which only the sweep's wrap makes reachable.
    expect(writeOrder(h).slice(0, DEMAND_DWELL_SEGMENTS)).toEqual(run(8, DEMAND_DWELL_SEGMENTS));
    expect(writeOrder(h)[DEMAND_DWELL_SEGMENTS]).toBe(4);
  });
});

/**
 * Two readers that both keep re-parking as they consume, sixteen segments
 * apart. This is the shape that oscillates: each is woken by the last segment
 * of its own run and asks for the next one, and that demand arrives just after
 * the fetcher has turned away.
 */
function persistentReaders(h: Harness): readonly [Promise<Buffer>, Promise<Buffer>] {
  return [reader(h, 0, 16), reader(h, 20, 40)];
}

describe('Download demand between two persistent readers', () => {
  it('gives each of them a whole dwell at a time', async () => {
    const h = (openHarness = await harness(LONG));
    const [behind, ahead] = persistentReaders(h);

    expect((await ahead).equals(segmentsOf(h, 20, 40))).toBe(true);
    expect((await behind).equals(segmentsOf(h, 0, 16))).toBe(true);

    // A dwell each, in turn, and the tail once the reader behind is done.
    // With a dwell of one this is 20,0,21,1,22,2 ... all the way down.
    expect(writeOrder(h)).toEqual([...run(20, 16), ...run(0, 16), ...run(36, 4)]);
  });

  it('costs a fixed number of articles to serve them both', async () => {
    const h = (openHarness = await harness(LONG));
    const [behind, ahead] = persistentReaders(h);
    await Promise.all([behind, ahead]);
    await vi.waitFor(() => {
      expect(h.download.coverage.count).toBe(36);
    });
    await flush();

    // 42 = 36 segments + 1 article for the geometry probe `openNzbFile` does
    // + 5 thrown away. The 37 are structural and cannot move without the walk
    // itself changing; the 5 are the arbitration, and are the number to look
    // at if this ever drifts: two in flight at the anchor of 0 when the second
    // reader's demand superseded the first's, then a pair at each of the two
    // turns. The same pair with a dwell of one costs 102 for the same 36.
    expect(h.source.requestCount).toBe(42);
  });
});

/**
 * A file whose middle is gone, with the walk stalled just before it.
 *
 * Segments 2 to 18 are expired articles, segment 1's is held. Two readers set
 * up a rotation first — a rotation is the only thing that defers a seek — so
 * by the time this returns the fetcher has turned to segment 0, written it,
 * and blocked on 1 with the dead run immediately ahead of it.
 */
async function stalledBeforeDeadRun(): Promise<Harness> {
  const h = (openHarness = await harness(LONG));
  const ids = h.post.file.segments.map((segment) => segment.messageId);
  h.source.hold(ids[1]!);
  for (let segment = 2; segment <= 18; segment += 1) {
    h.source.fail(ids[segment]!, new Error('430 No such article'));
  }

  const stranded = reader(h, 0, 1);
  expect((await reader(h, 20, 21)).equals(segmentsOf(h, 20, 21))).toBe(true);
  expect((await stranded).equals(segmentsOf(h, 0, 1))).toBe(true);
  return h;
}

describe('Download demand across a dead region', () => {
  it('counts a dead segment towards the dwell, so a seek away is honoured', async () => {
    const h = await stalledBeforeDeadRun();
    const ids = h.post.file.segments.map((segment) => segment.messageId);

    // The seek the spec describes: the user reaches a region the provider no
    // longer has, sees the zeros it reads back as, and jumps away. It arrives
    // while a rotation is protecting the current anchor, so it is deferred --
    // and a dead segment costs two article requests to establish, so if that
    // work did not advance the dwell nothing would release it until the run
    // ended. Measured: the seek lands after the whole run and two more passes.
    const seeker = reader(h, 38, 39);
    h.source.release(ids[1]!);
    expect((await seeker).equals(segmentsOf(h, 38, 39))).toBe(true);

    // Sixteen segments of work after the turn to 0 -- two written, fourteen
    // given up on -- and then the seek, exactly as if all sixteen had landed.
    expect(writeOrder(h).slice(16, 17 + DEMAND_DWELL_SEGMENTS)).toEqual([
      ...run(0, DEMAND_DWELL_SEGMENTS),
      38,
    ]);
    // It turned away mid-run rather than grinding to the end of it.
    expect(h.download.dead.runs).toEqual([[2, 16]]);
  });
});

describe('Download demand for a candidate the walk is nearly at', () => {
  it('walks the last few segments rather than paying a rotation for them', async () => {
    const h = (openHarness = await harness(LONG));
    const ids = h.post.file.segments.map((segment) => segment.messageId);
    h.source.hold(ids[5]!);

    // The head reader parks at 0 and is superseded, the walk from 21 spends a
    // dwell, and the fetcher rotates back to it. That rotation is the setup:
    // under it a hint cannot move the walk, so the only thing that can is the
    // rotation rule, which is what this pins. It writes 0 to 4 and blocks.
    const head = reader(h, 0, 17);
    expect((await reader(h, 21, 22)).equals(segmentsOf(h, 21, 22))).toBe(true);
    await vi.waitFor(() => {
      expect(h.download.coverage.has(4)).toBe(true);
    });

    // Parked four ahead of where the walk stands when its dwell runs out.
    const ahead = reader(h, 20, 21);
    h.source.release(ids[5]!);

    expect((await head).equals(segmentsOf(h, 0, 17))).toBe(true);
    expect((await ahead).equals(segmentsOf(h, 20, 21))).toBe(true);
    await vi.waitFor(() => {
      expect(h.download.coverage.count).toBe(40);
    });

    // Unbroken from 0 to 20. Filtered at the prefetch window instead, the
    // fetcher abandons the walk at 16 to reach 20 -- five articles to arrive
    // four segments early -- leaving [16,20) as a fresh hole and the head
    // reader stranded at 16 until the sweep wraps back to it, which reads
    // 0..15, 20, 37, 38, 39, 16..19.
    expect(writeOrder(h).slice(DEMAND_DWELL_SEGMENTS)).toEqual([...run(0, 21), 37, 38, 39]);
  });
});

describe('Download demand on the common path', () => {
  it('fetches every article exactly once for one sequential reader', async () => {
    const h = (openHarness = await harness(LONG));
    // One reader, no contention: the shape almost every byte of a real
    // playback session takes. Pinned because the guard that makes it hold is
    // four lines and a change to when coverage admits a segment relative to
    // the notify beside it would defeat it with the rest of the suite green.
    //
    // 37 = the geometry probe, plus segments 4 to 39 once each: the reader's
    // own range and the tail the walk carries on to. Before the demand policy
    // this same read cost 67, because the reader asking for its next segment
    // arrived looking like a backwards seek and re-anchored the walk, once
    // per segment, abandoning what was in flight each time.
    await collect(h.download.read(4 * SEG, 20 * SEG));
    await vi.waitFor(() => {
      expect(h.download.coverage.count).toBe(36);
    });
    await flush();

    expect(h.source.requestCount).toBe(37);
  });
});
