/** A failure the job cannot continue past: bad geometry, or a dead disk. */
export class FatalDownloadError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FatalDownloadError';
    this.code = code;
  }
}

/**
 * Said when a post's articles are not the size its geometry predicts.
 *
 * Byte offsets on Usenet are arithmetic over a uniform article size. When that
 * arithmetic is provably wrong, there is nothing to fall back on — every read
 * would return bytes from somewhere else in the file — so the job stops
 * instead of serving a corrupt stream.
 */
export const NON_UNIFORM_GEOMETRY =
  'This post uses variable article sizes, so byte offsets cannot be computed and it cannot be streamed.';
