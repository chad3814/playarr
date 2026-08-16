/**
 * Live-provider smoke check. Opt-in:
 *
 *   NNTP_HOST=… NNTP_USERNAME=… NNTP_PASSWORD=… \
 *     node --experimental-strip-types scripts/smoke.ts path/to/release.nzb
 *
 * Never runs in CI. It fetches a handful of real articles and writes nothing
 * outside a temp directory.
 *
 * This is a CLI that does one thing and exits, so the async/sync-API
 * preference does not apply here the way it does in the app itself — every
 * filesystem call below still goes through `node:fs/promises` anyway, since
 * there is nothing else in the process for a sync call to block.
 */
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NntpPool } from '@chad3814/nntp';
import { openNzbFile } from '@chad3814/nzb';
import { parseNzb } from '@chad3814/nzb-parser';
import { chain, fromEnv, fromFile } from '@chad3814/secret-provider';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: smoke.ts <file.nzb>');
  process.exit(2);
}

const host = process.env['NNTP_HOST'];
if (host === undefined || host === '') {
  console.error('NNTP_HOST is not set');
  process.exit(2);
}

const pool = new NntpPool({
  endpoint: {
    host,
    port: Number(process.env['NNTP_PORT'] ?? '563'),
    security: 'implicit',
  },
  credentials: {
    user: chain(fromEnv('NNTP_USERNAME'), fromFile('/run/secret/nntp_username')),
    pass: chain(fromEnv('NNTP_PASSWORD'), fromFile('/run/secret/nntp_password')),
  },
  connections: Number(process.env['NNTP_CONNECTIONS'] ?? '4'),
});

const nzb = parseNzb(await readFile(path, 'utf8'));
const mp4 = nzb.files.find((file) => file.subjectHints.name?.toLowerCase().endsWith('.mp4'));
if (mp4 === undefined) {
  console.error('no .mp4 in that NZB');
  process.exit(1);
}

const handle = await openNzbFile(mp4, pool, {
  prefetch: Number(process.env['NNTP_CONNECTIONS'] ?? '4'),
});
console.log(`name=${handle.name} size=${handle.size} segments=${handle.geometry.segmentCount}`);
console.log(`uniform=${handle.geometry.uniform} segmentSize=${handle.geometry.segmentSize}`);

const dir = await mkdtemp(join(tmpdir(), 'playarr-smoke-'));
const out = join(dir, handle.name);
const fd = await open(out, 'w+');
await fd.truncate(handle.size);

// `NzbFileHandle` has no `writeTo`; the only ways to pull bytes out of a
// slice are `bytes()`/`arrayBuffer()`/`stream()`. A head+tail preview is
// small (at most two segments), so buffering each slice whole and writing it
// at its real offset is simpler than streaming and just as correct.
const head = handle.geometry.segmentSize;
const headBytes = await handle.slice(0, head).bytes();
await fd.write(headBytes, 0, headBytes.byteLength, 0);
const tailBytes = await handle.slice(-head).bytes();
await fd.write(tailBytes, 0, tailBytes.byteLength, handle.size - tailBytes.byteLength);
await fd.close();

console.log(`wrote head+tail to ${out}`);
console.log('ffprobe it — a faststart or back-loaded moov should both read:');
console.log(
  `  ffprobe -v error -show_entries stream=codec_name,width,height -of default=nw=1 "${out}"`,
);

pool.destroy();
if (process.env['PLAYARR_SMOKE_KEEP'] !== '1') {
  await rm(dir, { recursive: true, force: true });
}
