import { describe, expect, it } from 'vitest';
import { resolveOutputName } from '../src/jobs/naming.ts';

describe('resolveOutputName', () => {
  it('prefers the authoritative yEnc header name', () => {
    expect(resolveOutputName('Real.Name.mp4', 'Guessed.Name.mp4')).toBe('Real.Name.mp4');
  });

  it('falls back to the subject when the header name has no extension', () => {
    // Obfuscated posts randomise =ybegin name= per article, so the
    // "authoritative" name can be an extensionless random string that nothing
    // can open.
    expect(resolveOutputName('sGxlgomUUnf2DJFts7f8MxYZgurfWfu', 'Some.Film.mp4')).toBe(
      'Some.Film.mp4',
    );
  });

  it('keeps the header name when neither has an extension', () => {
    expect(resolveOutputName('abc123', 'def456')).toBe('abc123');
  });

  it('keeps the header name when the subject offers nothing', () => {
    expect(resolveOutputName('abc123', null)).toBe('abc123');
  });

  it('strips any directory component from the header name', () => {
    expect(resolveOutputName('../../etc/passwd', null)).toBe('passwd');
    expect(resolveOutputName('/absolute/Film.mp4', null)).toBe('Film.mp4');
    expect(resolveOutputName('nested\\windows\\Film.mp4', null)).toBe('Film.mp4');
  });

  it('falls back to a safe name when nothing usable survives sanitising', () => {
    expect(resolveOutputName('..', null)).toBe('download.bin');
    expect(resolveOutputName('', null)).toBe('download.bin');
  });
});
