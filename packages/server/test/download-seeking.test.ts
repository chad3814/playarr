import { afterEach, describe, expect, it } from 'vitest';
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

describe('Download seeking', () => {
  it('does not re-anchor for a seek already inside the prefetch window', async () => {
    const h = (openHarness = await harness(EIGHT));
    const ids = messageIds(h);
    h.download.want(0);
    await h.download.waitFor(0);

    h.download.want(1);
    await h.download.waitFor(1);

    const seen = h.source.requested.filter((id) => ids.includes(id));
    expect(seen.slice(0, 2)).toEqual([ids[0], ids[1]]);
    expect(seen.filter((id) => id === ids[1])).toHaveLength(1);
  });

  it('re-anchors on a far-forward seek', async () => {
    const h = (openHarness = await harness(EIGHT));
    const ids = messageIds(h);

    h.download.want(0);
    await h.download.waitFor(0);

    h.download.want(6);
    await h.download.waitFor(6);
    expect(h.download.coverage.has(6)).toBe(true);
    expect(h.source.requested).not.toContain(ids[4]);
    expect(h.source.requested).not.toContain(ids[5]);
  });
});

describe('Download seeking into covered bytes', () => {
  it('costs nothing to seek backwards into covered bytes', async () => {
    const h = (openHarness = await harness());
    await h.download.prime();
    h.download.want(2);
    await h.download.waitFor(2);
    const before = h.source.requestCount;

    const head = await collect(h.download.read(0, SEG));
    expect(head.equals(h.post.data.subarray(0, SEG))).toBe(true);
    await flush();
    expect(h.source.requestCount).toBe(before);
  });

  it('skips a covered run rather than refetching it', async () => {
    const h = (openHarness = await harness());
    const ids = messageIds(h);
    await h.download.prime();

    h.download.want(1);
    await h.download.waitFor(3);
    const tailRequests = h.source.requested.filter((id) => id === ids[4]).length;
    expect(tailRequests).toBe(1);
  });
});
