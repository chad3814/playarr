import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeFixture, fixture, selectRequest, SEG } from './select-harness.ts';

afterEach(closeFixture);

describe('JobManager.activate', () => {
  it('resumes a released job from its persisted coverage', async () => {
    const f = await fixture();
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
    const f = await fixture();
    await f.app.inject(selectRequest(f.jobId, 0));
    const running = f.manager.active();
    expect(await f.manager.activate(f.jobId)).toBe(running);
  });
});

describe('JobManager.activate - rejected requests', () => {
  it('409s a job that has no selection yet', async () => {
    const f = await fixture();
    await expect(f.manager.activate(f.jobId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'not-selected',
    });
  });

  it('404s a job that does not exist', async () => {
    const f = await fixture();
    await expect(f.manager.activate('nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('412s once the provider has gone away', async () => {
    const f = await fixture();
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
    const f = await fixture();
    expect(f.manager.activeRecord()).toBeNull();

    await f.app.inject(selectRequest(f.jobId, 0));
    expect(f.manager.activeRecord()?.state.id).toBe(f.jobId);

    await f.manager.releaseAll();
    expect(f.manager.activeRecord()).toBeNull();
  });
});

describe('JobManager background persistence failures', () => {
  it('reports a rejected coverage write instead of leaving it unhandled', async () => {
    const f = await fixture();
    await f.app.inject(selectRequest(f.jobId, 0));

    f.store.armed = true;
    // Segment 1 is the hole prime() left behind, so wanting it produces a real
    // article fetch, a real onCoverage call, and a real write behind it.
    f.manager.active()!.want(1);

    await vi.waitFor(() => {
      expect(f.onError).toHaveBeenCalled();
    });
    expect(f.onError.mock.calls[0]?.[0]).toBe(f.jobId);
    expect(f.onError.mock.calls[0]?.[1].message).toContain('ENOSPC');
  });

  it('keeps fetching after a coverage write fails', async () => {
    const f = await fixture();
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
