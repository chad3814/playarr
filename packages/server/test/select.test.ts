import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobDto } from '@playarr/shared';
import { JobStore } from '../src/jobs/store.ts';
import { closeFixture, fixture, multipart, nzbFor, selectRequest, SEG } from './select-harness.ts';

afterEach(closeFixture);

describe('POST /api/jobs/:id/select', () => {
  it('probes the file, sizes the sparse file, and primes head and tail', async () => {
    const f = await fixture();
    const response = await f.app.inject(selectRequest(f.jobId, 0));

    expect(response.statusCode).toBe(200);
    const job = response.json<JobDto>();
    expect(job.status).toBe('ready');
    expect(job.active).toBe(true);
    expect(job.selection?.name).toBe('Some.Film.mp4');
    expect(job.selection?.size).toBe(3 * SEG + 400);
    expect(job.selection?.segmentCount).toBe(4);
    // The real check: prime() fetched exactly head and tail, and the fetcher
    // re-anchored past the tail rather than walking into it.
    expect(job.selection?.covered).toEqual([
      [0, 1],
      [3, 4],
    ]);

    const record = f.store.get(f.jobId)!;
    const file = await stat(join(record.dir, 'Some.Film.mp4'));
    expect(file.size).toBe(3 * SEG + 400);
    expect(f.onError).not.toHaveBeenCalled();
  });
});

describe('POST /api/jobs/:id/select - bytes on disk', () => {
  it('writes the head and tail the post actually carries', async () => {
    const f = await fixture();
    await f.app.inject(selectRequest(f.jobId, 0));

    const fd = f.manager.active()!.fd;
    const head = Buffer.alloc(SEG);
    await fd.read(head, 0, SEG, 0);
    const tail = Buffer.alloc(400);
    await fd.read(tail, 0, 400, 3 * SEG);

    expect(head).toEqual(f.post.data.subarray(0, SEG));
    expect(tail).toEqual(f.post.data.subarray(3 * SEG));
  });
});

describe('POST /api/jobs/:id/select - output naming', () => {
  it('uses the subject name when the header name is obfuscated', async () => {
    const f = await fixture({
      name: 'sGxlgomUUnf2DJFts7f8MxYZgurfWfu',
      subject: '[1/1] - &quot;Real.Film.mp4&quot; yEnc (1/4)',
    });
    const job = (await f.app.inject(selectRequest(f.jobId, 0))).json<JobDto>();
    expect(job.selection?.name).toBe('Real.Film.mp4');
  });

  it('refuses a file that turns out not to be an MP4', async () => {
    const f = await fixture({
      name: 'Some.Film.mkv',
      subject: '[1/1] - &quot;a7f3b2c1&quot; yEnc (1/4)',
    });
    const response = await f.app.inject(selectRequest(f.jobId, 0));
    expect(response.statusCode).toBe(415);
    expect(response.json<{ code: string }>().code).toBe('not-mp4');
  });
});

describe('POST /api/jobs/:id/select - rejected requests', () => {
  it('412s when no provider is configured', async () => {
    const f = await fixture({ configured: false });
    const response = await f.app.inject(selectRequest(f.jobId, 0));
    expect(response.statusCode).toBe(412);
    expect(response.json<{ code: string }>().code).toBe('not-configured');
  });

  it('400s an out-of-range file index', async () => {
    const f = await fixture();
    const response = await f.app.inject(selectRequest(f.jobId, 9));
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('bad-file-index');
  });

  it('400s a body the schema rejects', async () => {
    const f = await fixture();
    const response = await f.app.inject(selectRequest(f.jobId, -1));
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('bad-request');
  });

  it('404s an unknown job', async () => {
    const f = await fixture();
    const response = await f.app.inject(selectRequest('nope', 0));
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/jobs/:id/select - server-side failures', () => {
  it('reports a failure to persist as a server fault, without leaking it', async () => {
    const f = await fixture();
    f.store.armed = true;

    const response = await f.app.inject(selectRequest(f.jobId, 0));
    expect(response.statusCode).toBe(500);
    expect(response.json<{ code: string }>().code).toBe('internal');
    expect(response.body).not.toContain('ENOSPC');
    // No job took the pool, so the next selection starts from a clean slate.
    expect(f.manager.activeId).toBeNull();
    expect(f.store.get(f.jobId)?.state.status).toBe('uploaded');
  });
});

describe('POST /api/jobs/:id/select - persistence', () => {
  it('persists the selection so a restart can resume it', async () => {
    const f = await fixture();
    await f.app.inject(selectRequest(f.jobId, 0));
    await f.manager.releaseAll();

    const reopened = new JobStore(join(f.store.get(f.jobId)!.dir, '..'));
    await reopened.scan();
    const state = reopened.get(f.jobId)!.state;
    expect(state.status).toBe('paused');
    expect(state.selection?.name).toBe('Some.Film.mp4');
    expect(state.selection?.covered).toEqual([
      [0, 1],
      [3, 4],
    ]);
    await reopened.dispose();
  });
});

describe('POST /api/jobs/:id/select - handing over the pool', () => {
  it('starts the newest selection and pauses the one it displaced', async () => {
    const f = await fixture();
    await f.app.inject(selectRequest(f.jobId, 0));
    const first = f.manager.active();
    expect(first).not.toBeNull();

    const subject = '[1/1] - &quot;Some.Film.mp4&quot; yEnc (1/4)';
    const second = (
      await f.app.inject({
        method: 'POST',
        url: '/api/jobs',
        ...multipart(nzbFor(f.post, subject), 'r2.nzb'),
      })
    ).json<JobDto>();
    await f.app.inject(selectRequest(second.id, 0));

    expect(f.manager.activeId).toBe(second.id);
    expect(f.manager.active()).not.toBe(first);
    expect(f.store.get(f.jobId)?.state.status).toBe('paused');
  });
});
