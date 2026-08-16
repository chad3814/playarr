import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNzbFile, type NzbFileHandle } from '@chad3814/nzb';
import { vi, type Mock } from 'vitest';
import { SegmentCoverage } from '../src/coverage/coverage.ts';
import { Download, type FatalDownloadError } from '../src/download/download.ts';
import { GatedArticleSource } from './gated-source.ts';
import { buildPost, type Post } from './post.ts';

export const SEG = 1_000;

/** Five segments of 1000 bytes, the last one short, so tail maths is exercised. */
export const SHORT_TAIL = [SEG, SEG, SEG, SEG, 400] as const;

/** Long enough that a seek to 6 is well outside a prefetch window of 2. */
export const EIGHT = [SEG, SEG, SEG, SEG, SEG, SEG, SEG, 400] as const;

export interface Harness {
  readonly download: Download;
  readonly post: Post;
  readonly source: GatedArticleSource;
  readonly handle: NzbFileHandle;
  readonly onCoverage: Mock<(segment: number) => void>;
  readonly onFatal: Mock<(error: FatalDownloadError) => void>;
  readonly onDrained: Mock<() => void>;
  readonly onObserverError: Mock<(error: Error) => void>;
  close(): Promise<void>;
}

/**
 * A `Download` over a real synthetic post, writing to a real sparse file.
 *
 * Real on both sides on purpose: the fetcher's only job is to get decoded
 * bytes onto a descriptor at the right offsets, and neither a fake article nor
 * a fake fd would prove it did.
 */
export async function harnessFor(post: Post): Promise<Harness> {
  const source = new GatedArticleSource(post.source);
  const handle = await openNzbFile(post.file, source, { prefetch: 2 });

  const dir = await mkdtemp(join(tmpdir(), 'playarr-download-'));
  const fd = await open(join(dir, 'out.mp4'), 'w+');
  await fd.truncate(handle.size);

  const onCoverage = vi.fn<(segment: number) => void>();
  const onFatal = vi.fn<(error: FatalDownloadError) => void>();
  const onDrained = vi.fn<() => void>();
  const onObserverError = vi.fn<(error: Error) => void>();
  const download = new Download({
    handle,
    fd,
    coverage: new SegmentCoverage(handle.geometry.segmentCount),
    dead: new SegmentCoverage(handle.geometry.segmentCount),
    prefetch: 2,
    onCoverage,
    onDrained,
    onFatal,
    onObserverError,
  });

  return {
    download,
    post,
    source,
    handle,
    onCoverage,
    onFatal,
    onDrained,
    onObserverError,
    close: async () => {
      await download.stop();
      await fd.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function harness(sizes: readonly number[] = SHORT_TAIL): Promise<Harness> {
  return harnessFor(buildPost({ name: 'Some.Film.mp4', segmentSizes: sizes }));
}

export function messageIds(h: Harness): readonly string[] {
  return h.post.file.segments.map((segment) => segment.messageId);
}

export async function collect(chunks: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) {
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/**
 * Yield a whole event-loop turn.
 *
 * A negative assertion made after only a microtask or two passes vacuously:
 * the real `fs` work this download does resolves on a macrotask, so anything
 * asserting that something did *not* happen has to let one go by first.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
