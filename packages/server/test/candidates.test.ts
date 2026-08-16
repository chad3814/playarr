import { parseNzb } from '@chad3814/nzb-parser';
import { describe, expect, it } from 'vitest';
import { deriveCandidates, isMp4Name } from '../src/jobs/candidates.ts';

function nzbWith(subjects: readonly string[]): string {
  const files = subjects
    .map(
      (subject) => `
  <file poster="p@example.com" date="1700000000" subject="${subject}">
    <groups><group>alt.binaries.test</group></groups>
    <segments>
      <segment bytes="500" number="1">a@example.com</segment>
      <segment bytes="500" number="2">b@example.com</segment>
    </segments>
  </file>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="iso-8859-1" ?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">${files}</nzb>`;
}

describe('isMp4Name', () => {
  it('matches case-insensitively', () => {
    expect(isMp4Name('Film.MP4')).toBe(true);
    expect(isMp4Name('film.mp4')).toBe(true);
  });

  it('rejects other containers and a null name', () => {
    expect(isMp4Name('film.mkv')).toBe(false);
    expect(isMp4Name('film.mp4.par2')).toBe(false);
    expect(isMp4Name(null)).toBe(false);
  });
});

describe('deriveCandidates', () => {
  it('marks only the MP4s selectable when names are readable', () => {
    const nzb = parseNzb(
      nzbWith([
        '[1/3] - &quot;Some.Film.mp4&quot; yEnc (1/2)',
        '[2/3] - &quot;Some.Film.nfo&quot; yEnc (1/2)',
        '[3/3] - &quot;Some.Film.mkv&quot; yEnc (1/2)',
      ]),
    );
    const { candidates, namesUnresolved } = deriveCandidates(nzb);

    expect(namesUnresolved).toBe(false);
    expect(candidates.map((c) => c.selectable)).toEqual([true, false, false]);
    expect(candidates[0]?.subjectName).toBe('Some.Film.mp4');
    expect(candidates[0]?.encodedBytes).toBe(1_000);
    expect(candidates[0]?.segmentCount).toBe(2);
  });

  it('offers every file when no subject yields a usable extension', () => {
    const nzb = parseNzb(
      nzbWith([
        '[1/2] - &quot;a7f3b2c1&quot; yEnc (1/2)',
        '[2/2] - &quot;d8e4f5a6&quot; yEnc (1/2)',
      ]),
    );
    const { candidates, namesUnresolved } = deriveCandidates(nzb);

    expect(namesUnresolved).toBe(true);
    expect(candidates.every((c) => c.selectable)).toBe(true);
  });

  it('does not fall back to offering everything when one MP4 was found', () => {
    const nzb = parseNzb(
      nzbWith([
        '[1/2] - &quot;Some.Film.mp4&quot; yEnc (1/2)',
        '[2/2] - &quot;a7f3b2c1&quot; yEnc (1/2)',
      ]),
    );
    const { candidates, namesUnresolved } = deriveCandidates(nzb);

    expect(namesUnresolved).toBe(false);
    expect(candidates.map((c) => c.selectable)).toEqual([true, false]);
  });
});
