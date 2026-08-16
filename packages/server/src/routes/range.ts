export type ParsedRange =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

const BYTES = /^bytes=(.*)$/iu;

/**
 * Parse an HTTP `Range` header into a half-open `[start, end)`.
 *
 * HTTP is inclusive at the end and everything else here is half-open, so this
 * conversion happens exactly once, in one place.
 */
export function parseRangeHeader(header: string | undefined, size: number): ParsedRange {
  if (header === undefined) {
    return { kind: 'full' };
  }
  const match = BYTES.exec(header.trim());
  if (match === null) {
    return { kind: 'full' };
  }
  if (size === 0) {
    return { kind: 'unsatisfiable' };
  }

  const first = match[1]!.split(',')[0]!.trim();
  const dash = first.indexOf('-');
  if (dash < 0) {
    return { kind: 'unsatisfiable' };
  }

  const rawStart = first.slice(0, dash).trim();
  const rawEnd = first.slice(dash + 1).trim();

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (rawEnd === '' || !Number.isInteger(suffix) || suffix <= 0) {
      return { kind: 'unsatisfiable' };
    }
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0 || start >= size) {
    return { kind: 'unsatisfiable' };
  }

  if (rawEnd === '') {
    return { kind: 'partial', start, end: size };
  }

  const inclusiveEnd = Number(rawEnd);
  if (!Number.isInteger(inclusiveEnd) || inclusiveEnd < start) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'partial', start, end: Math.min(size, inclusiveEnd + 1) };
}
