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

    // 36 segments, one article for the geometry probe `openNzbFile` does, and
    // five thrown away: two in flight at the anchor of 0 when the second
    // reader's demand superseded the first's, then a pair at each of the two
    // turns. That is the whole cost of arbitrating between them. The same pair
    // with a dwell of one costs 102 articles for the same 36 segments.
    expect(h.source.requestCount).toBe(42);
  });
});
