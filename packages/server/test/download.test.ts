import { afterEach, describe, expect, it, vi } from 'vitest';
import { FatalDownloadError } from '../src/download/download.ts';
import {
  collect,
  EIGHT,
  flush,
  harness,
  harnessFor,
  messageIds,
  SEG,
  type Harness,
} from './download-harness.ts';
import { buildPost, type WireRange } from './post.ts';

let openHarness: Harness | null = null;

afterEach(async () => {
  await openHarness?.close();
  openHarness = null;
});

describe('Download.prime', () => {
  it('covers exactly the first and last segments', async () => {
    const h = (openHarness = await harness());
    await h.download.prime();

    expect(h.download.coverage.has(0)).toBe(true);
    expect(h.download.coverage.has(4)).toBe(true);
    expect(h.download.coverage.has(1)).toBe(false);
    expect(h.download.coverage.count).toBe(2);
  });

  it('writes the real head and tail bytes to disk', async () => {
    const h = (openHarness = await harness());
    await h.download.prime();

    const head = await collect(h.download.read(0, SEG));
    expect(head.equals(h.post.data.subarray(0, SEG))).toBe(true);

    const tail = await collect(h.download.read(4 * SEG, h.handle.size));
    expect(tail.equals(h.post.data.subarray(4 * SEG))).toBe(true);
  });
});

describe('Download.prime cost', () => {
  // Measured, not bounded. Segment 0's article is the one `openNzbFile`
  // already paid for and kept, so index 0 is never re-requested. The head pass
  // then starts three more -- the handle's prefetch window of two, plus the one
  // started as segment 0's article is consumed -- before it can see the first
  // article and act on prime()'s seek to the tail. All three are discarded
  // unwritten. Pinned because that is four articles to cover two segments on
  // the hottest path in the application, and nothing else makes it visible.
  it('costs four articles to cover those two segments', async () => {
    const h = (openHarness = await harness());
    const ids = messageIds(h);
    await h.download.prime();
    await flush();

    expect(h.source.requested.map((id) => ids.indexOf(id))).toEqual([0, 1, 2, 3, 4]);
    expect(h.source.requestCount).toBe(5);
  });

  // The same four on a longer post, where three abandoned articles and a walk
  // of the whole file are finally distinguishable -- on the five-segment
  // fixture both spend exactly [0,1,2,3,4], so that test alone cannot tell a
  // regression in the seek from a regression in the count.
  it('does not grow that cost on a longer post', async () => {
    const h = (openHarness = await harness(EIGHT));
    const ids = messageIds(h);
    await h.download.prime();
    await flush();

    expect(h.source.requested.map((id) => ids.indexOf(id))).toEqual([0, 1, 2, 3, 7]);
    expect(h.source.requestCount).toBe(5);
  });
});

describe('Download.read', () => {
  it('serves covered bytes without requesting a single article', async () => {
    const h = (openHarness = await harness());
    await h.download.prime();
    const before = h.source.requestCount;

    const head = await collect(h.download.read(0, 500));
    expect(head.equals(h.post.data.subarray(0, 500))).toBe(true);
    await flush();
    expect(h.source.requestCount).toBe(before);
  });

  it('fetches an uncovered range and yields the right bytes', async () => {
    const h = (openHarness = await harness());
    await h.download.prime();

    const middle = await collect(h.download.read(SEG, 2 * SEG));
    expect(middle.equals(h.post.data.subarray(SEG, 2 * SEG))).toBe(true);
  });

  it('spans a segment boundary correctly', async () => {
    const h = (openHarness = await harness());
    const straddle = await collect(h.download.read(SEG - 100, SEG + 100));
    expect(straddle.equals(h.post.data.subarray(SEG - 100, SEG + 100))).toBe(true);
  });

  it('reads the whole file back byte-for-byte', async () => {
    const h = (openHarness = await harness());
    const all = await collect(h.download.read(0, h.handle.size));
    expect(all.equals(h.post.data)).toBe(true);
  });
});

describe('Download.read cancellation', () => {
  it('stops a parked reader when its signal aborts, leaving the fetcher alone', async () => {
    const h = (openHarness = await harness());
    const second = h.post.file.segments[1]!.messageId;
    h.source.hold(second);

    const controller = new AbortController();
    const reading = collect(h.download.read(SEG, 2 * SEG, controller.signal));
    await vi.waitFor(() => expect(h.source.requested).toContain(second));

    controller.abort();
    await expect(reading).rejects.toThrow(/abort/iu);

    h.source.release(second);
    await vi.waitFor(() => expect(h.download.coverage.has(1)).toBe(true));
    expect(h.source.requested.filter((id) => id === second)).toHaveLength(1);
  });
});

describe('Download article failures', () => {
  it('retries a failed article once, then marks it dead and carries on', async () => {
    const h = (openHarness = await harness());
    const ids = messageIds(h);
    h.source.fail(ids[2]!, new Error('430 No such article'));

    h.download.want(1);
    await h.download.waitFor(3);

    expect(h.download.dead.has(2)).toBe(true);
    expect(h.download.coverage.has(3)).toBe(true);
    expect(h.source.requested.filter((id) => id === ids[2])).toHaveLength(2);
    expect(h.onFatal).not.toHaveBeenCalled();
  });

  it('wakes a reader parked on a dead segment, serving zeros', async () => {
    const h = (openHarness = await harness());
    const ids = messageIds(h);
    h.source.fail(ids[1]!, new Error('430 No such article'));

    const chunk = await collect(h.download.read(SEG, 2 * SEG));
    expect(chunk).toHaveLength(SEG);
    expect(chunk.every((byte) => byte === 0)).toBe(true);
    expect(h.download.dead.has(1)).toBe(true);
  });
});

describe('Download write failures', () => {
  it('treats a write failure as fatal and rejects parked readers', async () => {
    const h = (openHarness = await harness());
    const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    // `fd` is a public field on Download precisely so this is reachable: a
    // disk that stops accepting writes is not something a retry can fix, and
    // it must not be mistaken for an expired article.
    vi.spyOn(h.download.fd, 'write').mockRejectedValue(enospc);

    // Asserted on before the wait below, not after: the reader rejects the
    // instant the write does, and a rejection left unattached across a timer
    // tick surfaces as an unhandled rejection.
    const reading = expect(collect(h.download.read(SEG, 2 * SEG))).rejects.toThrow(/write/iu);

    await vi.waitFor(() => expect(h.onFatal).toHaveBeenCalled());
    expect(h.onFatal.mock.calls[0]![0]).toBeInstanceOf(FatalDownloadError);
    expect(h.onFatal.mock.calls[0]![0].code).toBe('write-failed');
    expect(h.download.dead.has(1)).toBe(false);
    await reading;
  });

  it('treats a short write as fatal rather than leaving a torn segment', async () => {
    const h = (openHarness = await harness());
    vi.spyOn(h.download.fd, 'write').mockResolvedValue({ bytesWritten: 12, buffer: '' });

    const reading = expect(collect(h.download.read(SEG, 2 * SEG))).rejects.toThrow(/12 of 1000/u);

    await vi.waitFor(() => expect(h.onFatal).toHaveBeenCalled());
    expect(h.onFatal.mock.calls[0]![0].code).toBe('write-failed');
    expect(h.download.coverage.has(1)).toBe(false);
    await reading;
  });
});

describe('Download geometry failures', () => {
  it('refuses a post whose segments are not uniformly sized', async () => {
    const post = buildPost({ segmentSizes: [SEG, SEG, SEG], declaredTotalSize: 5_000 });
    const h = (openHarness = await harnessFor(post));

    await expect(h.download.prime()).rejects.toThrow(/variable article sizes/u);
    expect(h.onFatal).toHaveBeenCalledTimes(1);
    expect(h.onFatal.mock.calls[0]![0].code).toBe('non-uniform-geometry');
    expect(h.download.coverage.count).toBe(0);
    expect(h.download.dead.count).toBe(0);
  });

  it('refuses an article that is not where the geometry predicted', async () => {
    const declaredRanges = new Map<number, WireRange>([[2, [1_500, 2_500]]]);
    const post = buildPost({ segmentSizes: [SEG, SEG, SEG], declaredRanges });
    const h = (openHarness = await harnessFor(post));

    h.download.want(2);
    await expect(h.download.waitFor(2)).rejects.toThrow(/variable article sizes/u);
    expect(h.onFatal).toHaveBeenCalledTimes(1);
    expect(h.onFatal.mock.calls[0]![0].code).toBe('non-uniform-geometry');
    expect(h.download.dead.has(2)).toBe(false);
  });
});

describe('Download.stop', () => {
  it('rejects readers parked on segments that will never arrive', async () => {
    const h = (openHarness = await harness());
    const waiting = expect(h.download.waitFor(3)).rejects.toThrow(/stopped/u);

    await h.download.stop();
    await waiting;
    await expect(h.download.waitFor(3)).rejects.toThrow(/stopped/u);
  });
});

describe('Download progress', () => {
  it('reports geometry and covered bytes the tail does not round off', async () => {
    const h = (openHarness = await harness());
    expect(h.download.size).toBe(4 * SEG + 400);
    expect(h.download.segmentCount).toBe(5);
    expect(h.download.coveredBytes).toBe(0);

    await h.download.prime();
    expect(h.download.coveredBytes).toBe(SEG + 400);
    expect(Number.isInteger(h.download.bytesPerSecond)).toBe(true);
    expect(h.download.bytesPerSecond).toBeGreaterThanOrEqual(0);
  });
});
