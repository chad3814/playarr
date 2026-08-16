import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { vi, type Mock } from 'vitest';
import type { JobDto } from '@playarr/shared';
import { buildApp } from '../src/app.ts';
import { ConfigStore } from '../src/config/store.ts';
import { JobManager } from '../src/jobs/manager.ts';
import type { JobState } from '../src/jobs/state.ts';
import { JobStore } from '../src/jobs/store.ts';
import { PoolManager, type PoolLike } from '../src/nntp/pool.ts';
import { GatedArticleSource } from './gated-source.ts';
import { buildPost, type Post } from './post.ts';

export const SEG = 1_000;

/**
 * A store whose `update` can be made to reject on demand, the way a full or
 * read-only volume does. Drives the persistence a job launches in the
 * background, which has no caller to reject to.
 */
export class RefusingStore extends JobStore {
  armed = false;

  override update(id: string, next: JobState, options: { flush?: boolean } = {}): Promise<void> {
    if (this.armed) {
      return Promise.reject(new Error('ENOSPC: no space left on device'));
    }
    return super.update(id, next, options);
  }
}

export interface Fixture {
  readonly app: FastifyInstance;
  readonly store: RefusingStore;
  readonly pool: PoolManager;
  readonly manager: JobManager;
  readonly post: Post;
  /** Wraps the post's articles, so a test can park a call inside a fetch. */
  readonly source: GatedArticleSource;
  readonly jobId: string;
  readonly onError: Mock<(jobId: string, error: Error) => void>;
}

export interface FixtureOptions {
  readonly name?: string;
  readonly subject?: string;
  readonly sizes?: readonly number[];
  /** Defaults to true. False builds an app with no provider configured. */
  readonly configured?: boolean;
}

/** Turn a synthetic post into the NZB XML the upload endpoint expects. */
export function nzbFor(post: Post, subject: string): string {
  const segments = post.file.segments
    .map((s) => `<segment bytes="${s.bytes}" number="${s.number}">${s.messageId}</segment>`)
    .join('');
  return `<?xml version="1.0" encoding="iso-8859-1" ?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="p@example.com" date="1700000000" subject="${subject}">
    <groups><group>alt.binaries.test</group></groups>
    <segments>${segments}</segments>
  </file>
</nzb>`;
}

export function multipart(
  body: string,
  filename: string,
): { payload: string; headers: Record<string, string> } {
  const boundary = '----playarrtest';
  return {
    payload:
      `--${boundary}\r\nContent-Disposition: form-data; name="nzb"; filename="${filename}"\r\n` +
      `Content-Type: application/x-nzb\r\n\r\n${body}\r\n--${boundary}--\r\n`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export function selectRequest(
  jobId: string,
  fileIndex: number,
): { method: 'POST'; url: string; payload: { fileIndex: number } } {
  return { method: 'POST', url: `/api/jobs/${jobId}/select`, payload: { fileIndex } };
}

/** A pool that serves one synthetic post and never opens a socket. */
function poolFor(source: GatedArticleSource, configured: boolean): PoolManager {
  const pool = new PoolManager(
    () =>
      ({
        body: (id: string) => source.body(id),
        destroy: () => {},
        failures: [],
      }) as PoolLike,
  );
  if (configured) {
    pool.configure(
      { host: 'h', port: 563, security: 'implicit', connections: 2, username: 'u' },
      { user: 'u', pass: 'p' },
    );
  }
  return pool;
}

/** An app with one uploaded job, ready to be selected. Closed by `closeFixture`. */
export async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const post = buildPost({
    name: options.name ?? 'Some.Film.mp4',
    segmentSizes: options.sizes ?? [SEG, SEG, SEG, 400],
  });

  const root = await mkdtemp(join(tmpdir(), 'playarr-app-'));
  const store = new RefusingStore(join(root, 'jobs'));
  await store.scan();
  const source = new GatedArticleSource(post.source);
  const pool = poolFor(source, options.configured !== false);

  // Injected in every test so a background failure is asserted on rather than
  // written to stderr, and so a happy path can prove none was reported.
  const onError = vi.fn<(jobId: string, error: Error) => void>();
  const manager = new JobManager(store, pool, onError);
  const app = await buildApp({
    store,
    manager,
    config: new ConfigStore(join(root, 'config.json')),
    pool,
    env: {},
  });

  const subject = options.subject ?? '[1/1] - &quot;Some.Film.mp4&quot; yEnc (1/4)';
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/jobs',
      ...multipart(nzbFor(post, subject), 'r.nzb'),
    })
  ).json<JobDto>();

  return { app, store, pool, manager, post, source, jobId: created.id, onError };
}

/** Tear down a fixture `fixture()` built. Call from `afterEach`. */
export async function closeFixture(current: Fixture | null): Promise<void> {
  if (current === null) {
    return;
  }
  // Disarmed before releasing: releaseAll persists a 'paused' transition, and
  // a test that armed the store to prove a write failure must not fail its
  // own teardown the same way.
  current.store.armed = false;
  await current.manager.releaseAll();
  await current.store.dispose();
  await current.app.close();
}
