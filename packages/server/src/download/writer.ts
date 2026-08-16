import type { FileHandle } from 'node:fs/promises';
import { FatalDownloadError } from './errors.ts';

/**
 * Put one segment's decoded bytes where the geometry says they go.
 *
 * Kept apart from the fetcher because a write failure means something
 * categorically different from an article failure: the provider is fine, the
 * disk is not, and neither a retry nor marking the segment dead helps. Every
 * error out of here is fatal, and mistaking one for an expired article would
 * quietly turn a full disk into a file full of holes.
 */
export async function writeSegment(
  fd: FileHandle,
  segment: number,
  offset: number,
  chunk: Uint8Array,
): Promise<void> {
  let written: number;
  try {
    const result = await fd.write(chunk, 0, chunk.byteLength, offset);
    written = result.bytesWritten;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FatalDownloadError('write-failed', `could not write segment ${segment}: ${reason}`, {
      cause: error,
    });
  }

  if (written !== chunk.byteLength) {
    throw new FatalDownloadError(
      'write-failed',
      `could not write segment ${segment}: wrote ${written} of ${chunk.byteLength} bytes`,
    );
  }
}
