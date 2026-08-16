import { basename } from 'node:path';

const FALLBACK = 'download.bin';

/** Strip every directory component. A name from an untrusted post is a filename, never a path. */
function sanitize(name: string): string {
  const flattened = name.replaceAll('\\', '/');
  const base = basename(flattened).trim();
  return base === '' || base === '.' || base === '..' ? '' : base;
}

function hasExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1;
}

/**
 * The yEnc header is authoritative and the subject is a guess, so the header
 * wins — unless the header has no extension and the subject offers one that
 * does. Obfuscated releases randomise `=ybegin name=` per article, and writing
 * an extensionless random string to disk gives a file nothing can open.
 *
 * Every return is a bare basename with no directory component, which is what
 * lets `JobStore.outputPath` accept the result unchanged.
 */
export function resolveOutputName(headerName: string, subjectName: string | null): string {
  const header = sanitize(headerName);
  const subject = subjectName === null ? '' : sanitize(subjectName);

  if (header !== '' && hasExtension(header)) {
    return header;
  }
  if (subject !== '' && hasExtension(subject)) {
    return subject;
  }
  if (header !== '') {
    return header;
  }
  return subject === '' ? FALLBACK : subject;
}
