import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from '../src/routes/range.ts';

describe('parseRangeHeader - full reads', () => {
  it('treats a missing or non-bytes header as a full read', () => {
    expect(parseRangeHeader(undefined, 1_000)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('items=0-1', 1_000)).toEqual({ kind: 'full' });
  });

  it('converts an inclusive range to a half-open one', () => {
    expect(parseRangeHeader('bytes=0-999', 1_000)).toEqual({
      kind: 'partial',
      start: 0,
      end: 1_000,
    });
    expect(parseRangeHeader('bytes=0-0', 1_000)).toEqual({ kind: 'partial', start: 0, end: 1 });
  });

  it('handles the open-ended form Chrome actually sends', () => {
    expect(parseRangeHeader('bytes=0-', 1_000)).toEqual({ kind: 'partial', start: 0, end: 1_000 });
    expect(parseRangeHeader('bytes=500-', 1_000)).toEqual({
      kind: 'partial',
      start: 500,
      end: 1_000,
    });
  });
});

describe('parseRangeHeader - suffix ranges and clamping', () => {
  it('handles a suffix range', () => {
    expect(parseRangeHeader('bytes=-200', 1_000)).toEqual({
      kind: 'partial',
      start: 800,
      end: 1_000,
    });
    expect(parseRangeHeader('bytes=-5000', 1_000)).toEqual({
      kind: 'partial',
      start: 0,
      end: 1_000,
    });
  });

  it('clamps an end past the file to the file', () => {
    expect(parseRangeHeader('bytes=900-99999', 1_000)).toEqual({
      kind: 'partial',
      start: 900,
      end: 1_000,
    });
  });
});

describe('parseRangeHeader - rejections', () => {
  it('rejects a start at or past the end of the file', () => {
    expect(parseRangeHeader('bytes=1000-', 1_000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=2000-3000', 1_000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('rejects a reversed or malformed range', () => {
    expect(parseRangeHeader('bytes=500-100', 1_000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=abc-def', 1_000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-', 1_000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports an empty file as unsatisfiable for any range', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('parseRangeHeader - multi-range requests', () => {
  it('takes only the first range of a multi-range request', () => {
    // Multipart byteranges are legal and no browser video element asks for them.
    expect(parseRangeHeader('bytes=0-99,200-299', 1_000)).toEqual({
      kind: 'partial',
      start: 0,
      end: 100,
    });
  });
});
