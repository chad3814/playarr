import type { Nzb } from '@chad3814/nzb-parser';
import type { CandidateFile } from '@playarr/shared';

export function isMp4Name(name: string | null): boolean {
  return name !== null && name.toLowerCase().endsWith('.mp4');
}

/**
 * Which files in the document a user may pick, known without any network.
 *
 * The subject is a guess and the yEnc header is authoritative, but the header
 * costs one article per file, so filtering happens on the guess. A fully
 * obfuscated post has no usable extension anywhere, and filtering it would
 * produce an empty list on exactly the releases this app is for — so when
 * nothing matches, everything is offered and `select` resolves the truth.
 */
export function deriveCandidates(nzb: Nzb): {
  candidates: CandidateFile[];
  namesUnresolved: boolean;
} {
  const named = nzb.files.map((file, fileIndex) => ({
    fileIndex,
    subjectName: file.subjectHints.name,
    encodedBytes: file.totalEncodedBytes,
    segmentCount: file.segments.length,
    playable: isMp4Name(file.subjectHints.name),
  }));

  const namesUnresolved = !named.some((entry) => entry.playable);

  return {
    namesUnresolved,
    candidates: named.map(({ playable, ...rest }) => ({
      ...rest,
      selectable: namesUnresolved || playable,
    })),
  };
}
