import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobDto } from '@playarr/shared';
import {
  closeFixture,
  fixture,
  multipart,
  nzbFor,
  selectRequest,
  SEG,
  type Fixture,
} from './app-fixture.ts';

let current: Fixture | null = null;

/**
 * Upload a second job carrying the same post.
 *
 * Overlapping selections have to name two different jobs to overlap at all:
 * re-selecting the file a job already has is a no-op by design, so two
 * concurrent selects of one job can no longer displace anything.
 */
async function anotherJob(f: Fixture): Promise<string> {
  const subject = '[1/1] - &quot;Some.Film.mp4&quot; yEnc (1/4)';
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/jobs',
    ...multipart(nzbFor(f.post, subject), 'r2.nzb'),
  });
  return response.json<JobDto>().id;
}

afterEach(async () => {
  await closeFixture(current);
  current = null;
});

/** Put a job in exactly the state `markJobFailed` leaves behind. */
async function failJob(f: Fixture): Promise<void> {
  const record = f.store.get(f.jobId)!;
  await f.store.update(
    f.jobId,
    {
      ...record.state,
      status: 'failed',
      failure: { code: 'non-uniform-geometry', message: 'variable article sizes' },
    },
    { flush: true },
  );
}

describe('JobManager.activate', () => {
  it('resumes a released job from its persisted coverage', async () => {
    current = await fixture();
    const f = current;
    await f.app.inject(selectRequest(f.jobId, 0));
    await f.manager.releaseAll();
    expect(f.manager.activeId).toBeNull();

    const download = await f.manager.activate(f.jobId);
    expect(f.manager.activeId).toBe(f.jobId);
    expect(download.coverage.runs).toEqual([
      [0, 1],
      [3, 4],
    ]);
    expect(f.store.get(f.jobId)?.state.status).toBe('ready');
  });

  it('returns the running download rather than reopening it', async () => {
    current = await fixture();
    const f = current;
    await f.app.inject(selectRequest(f.jobId, 0));
    const running = f.manager.active();
    expect(await f.manager.activate(f.jobId)).toBe(running);
  });
});

describe('JobManager.activate - rejected requests', () => {
  it('409s a job that has no selection yet', async () => {
    current = await fixture();
    const f = current;
    await expect(f.manager.activate(f.jobId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'not-selected',
    });
  });

  it('404s a job that does not exist', async () => {
    current = await fixture();
    const f = current;
    await expect(f.manager.activate('nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('412s once the provider has gone away', async () => {
    current = await fixture();
    const f = current;
    await f.app.inject(selectRequest(f.jobId, 0));
    await f.manager.releaseAll();
    await f.pool.destroy();

    await expect(f.manager.activate(f.jobId)).rejects.toMatchObject({
      statusCode: 412,
      code: 'not-configured',
    });
  });
});

describe('JobManager.activeRecord', () => {
  it('is null until a job is selected, and the record afterwards', async () => {
    current = await fixture();
    const f = current;
    expect(f.manager.activeRecord()).toBeNull();

    await f.app.inject(selectRequest(f.jobId, 0));
    expect(f.manager.activeRecord()?.state.id).toBe(f.jobId);

    await f.manager.releaseAll();
    expect(f.manager.activeRecord()).toBeNull();
  });
});

describe('JobManager single-flight ownership', () => {
  it('stops and closes the download a concurrent selection displaces', async () => {
    current = await fixture();
    const f = current;
    const second = await anotherJob(f);
    const probe = f.post.file.segments[0]!.messageId;
    const tail = f.post.file.segments[3]!.messageId;
    f.source.hold(probe);
    f.source.hold(tail);

    // A parks inside #open, on the one article openNzbFile fetches.
    const a = f.app.inject(selectRequest(f.jobId, 0));
    await vi.waitFor(() => {
      expect(f.source.requested).toContain(probe);
    });

    // B starts while A is mid-probe. Ungated it walks into its own #open and
    // races A to `#active`; gated it waits for A to finish.
    const b = f.app.inject(selectRequest(second, 0));
    // One whole event-loop turn, then a negative assertion: A is still parked
    // on the held probe and has not reached #begin, so the two calls really do
    // overlap rather than running back to back.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(f.manager.active()).toBeNull();
    f.source.release(probe);

    // A now owns the job and is parked in prime(), waiting for the tail. The
    // wait is generous because reaching #begin costs a decode plus a real
    // state.json write and rename, and this asserts what happened, not how
    // fast a loaded machine got there.
    await vi.waitFor(() => expect(f.manager.active()).not.toBeNull(), { timeout: 10_000 });
    const displaced = f.manager.active()!;

    f.source.release(tail);
    expect((await a).statusCode).toBe(200);
    expect((await b).statusCode).toBe(200);

    expect(f.manager.activeId).toBe(second);
    expect(f.manager.active()).not.toBe(displaced);
    // The descriptor A opened was closed, so nothing is writing behind B.
    await expect(displaced.fd.read(Buffer.alloc(1), 0, 1, 0)).rejects.toThrow(/file closed|EBADF/u);
    // ...and A's fetcher was stopped, so nothing will ever notify segment 2.
    await expect(displaced.waitFor(2)).rejects.toThrow();
    expect(f.onError).not.toHaveBeenCalled();
  });
});

describe('JobManager stale failures', () => {
  it('drops a previous attempt’s failure when a selection succeeds', async () => {
    current = await fixture();
    const f = current;
    await failJob(f);

    const job = (await f.app.inject(selectRequest(f.jobId, 0))).json<JobDto>();
    expect(job.status).toBe('ready');
    expect(job.failure).toBeUndefined();
    expect(f.store.get(f.jobId)?.state.failure).toBeUndefined();
  });

  it('drops it when a resume succeeds', async () => {
    current = await fixture();
    const f = current;
    await f.app.inject(selectRequest(f.jobId, 0));
    await f.manager.releaseAll();
    await failJob(f);

    await f.manager.activate(f.jobId);
    expect(f.store.get(f.jobId)?.state.status).toBe('ready');
    expect(f.store.get(f.jobId)?.state.failure).toBeUndefined();
  });
});

describe('JobManager background persistence failures', () => {
  it('reports a rejected coverage write instead of leaving it unhandled', async () => {
    current = await fixture();
    const f = current;
    await f.app.inject(selectRequest(f.jobId, 0));

    f.store.armed = true;
    // Segment 1 is the hole prime() left behind, so wanting it produces a real
    // article fetch, a real onCoverage call, and a real write behind it.
    f.manager.active()!.want(1);

    // Generous for the same reason as above: a real article fetch and a real
    // rejected write stand between want() and the report.
    await vi.waitFor(() => expect(f.onError).toHaveBeenCalled(), { timeout: 10_000 });
    expect(f.onError.mock.calls[0]?.[0]).toBe(f.jobId);
    expect(f.onError.mock.calls[0]?.[1].message).toContain('ENOSPC');
  });

  it('keeps fetching after a coverage write fails', async () => {
    current = await fixture();
    const f = current;
    await f.app.inject(selectRequest(f.jobId, 0));

    f.store.armed = true;
    const download = f.manager.active()!;
    download.want(1);
    await download.waitFor(1);

    expect(download.coverage.has(1)).toBe(true);
    const bytes = Buffer.alloc(SEG);
    await download.fd.read(bytes, 0, SEG, SEG);
    expect(bytes).toEqual(f.post.data.subarray(SEG, 2 * SEG));
  });
});
