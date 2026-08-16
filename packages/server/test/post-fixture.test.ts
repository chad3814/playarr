import { openNzbFile } from '@chad3814/nzb';
import { describe, expect, it } from 'vitest';
import { buildPost } from './post.ts';

describe('buildPost', () => {
  it('produces a post that @chad3814/nzb can open and read back byte-for-byte', async () => {
    const post = buildPost({ name: 'Some.Film.mp4', segmentSizes: [1_000, 1_000, 400] });
    const handle = await openNzbFile(post.file, post.source);

    expect(handle.name).toBe('Some.Film.mp4');
    expect(handle.size).toBe(2_400);
    expect(handle.geometry.segmentSize).toBe(1_000);
    expect(handle.geometry.lastSegmentSize).toBe(400);
    expect(handle.geometry.segmentCount).toBe(3);
    expect(handle.geometry.uniform).toBe(true);

    const bytes = await handle.bytes();
    expect(Buffer.from(bytes).equals(post.data)).toBe(true);
  });

  it('costs exactly one article to open', async () => {
    const post = buildPost({ segmentSizes: [1_000, 1_000] });
    await openNzbFile(post.file, post.source);
    expect(post.source.requestCount).toBe(1);
  });
});
