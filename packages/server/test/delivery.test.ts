import { get as httpGet } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadConflict, JobDto } from '@playarr/shared';
import { closeFixture, fixture, SEG, type Fixture } from './app-fixture.ts';

let current: Fixture | null = null;

async function selected(): Promise<Fixture> {
  current = await fixture();
  await current.app.inject({
    method: 'POST',
    url: `/api/jobs/${current.jobId}/select`,
    payload: { fileIndex: 0 },
  });
  return current;
}

afterEach(async () => {
  await closeFixture(current);
  current = null;
});

describe('GET /api/jobs/:id/download', () => {
  it('409s with a missing count while the file has holes', async () => {
    const f = await selected();
    const response = await f.app.inject({ method: 'GET', url: `/api/jobs/${f.jobId}/download` });

    expect(response.statusCode).toBe(409);
    // Four segments; prime() covers only the first and last ([0,1] and [3,4],
    // per select.test.ts), so the two in between are still missing.
    expect(response.json<DownloadConflict>().missing).toBe(2);
  });

  it('serves the finished file as an attachment', async () => {
    const f = await selected();
    expect(
      (await f.app.inject({ method: 'POST', url: `/api/jobs/${f.jobId}/complete` })).statusCode,
    ).toBe(200);

    const response = await f.app.inject({ method: 'GET', url: `/api/jobs/${f.jobId}/download` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="Some.Film.mp4"');
    expect(Number(response.headers['content-length'])).toBe(3 * SEG + 400);
    expect(Buffer.from(response.rawPayload).equals(f.post.data)).toBe(true);
  });
});

describe('POST /api/jobs/:id/complete', () => {
  it('fills every hole and reports the job complete', async () => {
    const f = await selected();
    const response = await f.app.inject({ method: 'POST', url: `/api/jobs/${f.jobId}/complete` });

    expect(response.statusCode).toBe(200);
    const job = response.json<JobDto>();
    expect(job.status).toBe('complete');
    expect(job.selection?.covered).toEqual([[0, 4]]);
  });

  it('completes despite a permanently dead segment, and says which', async () => {
    current = await fixture();
    const ids = current.post.file.segments.map((segment) => segment.messageId);
    await current.app.inject({
      method: 'POST',
      url: `/api/jobs/${current.jobId}/select`,
      payload: { fileIndex: 0 },
    });
    current.source.fail(ids[1]!, new Error('430 No such article'));

    const response = await current.app.inject({
      method: 'POST',
      url: `/api/jobs/${current.jobId}/complete`,
    });

    expect(response.statusCode).toBe(200);
    const job = response.json<JobDto>();
    expect(job.status).toBe('complete');
    expect(job.selection?.dead).toEqual([1]);
  });

  it('409s a job with no selection', async () => {
    current = await fixture();
    const response = await current.app.inject({
      method: 'POST',
      url: `/api/jobs/${current.jobId}/complete`,
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('POST /api/jobs/:id/complete - a fill that fails', () => {
  it('leaves the job out of `completing` rather than stuck in it', async () => {
    const f = await selected();
    vi.spyOn(f.manager.active()!, 'completeAll').mockRejectedValue(new Error('provider vanished'));

    const response = await f.app.inject({ method: 'POST', url: `/api/jobs/${f.jobId}/complete` });

    expect(response.statusCode).toBe(500);
    // 'completing' has no affordance behind it -- the finished dialog offers
    // Download and Delete, and neither gets a job out of it -- so a job left
    // there is stuck until the container restarts.
    expect(f.store.get(f.jobId)?.state.status).toBe('paused');
  });
});

describe('GET /api/jobs/:id/events', () => {
  it('emits an SSE progress frame immediately', async () => {
    const f = await selected();
    const response = await f.app.inject({
      method: 'GET',
      url: `/api/jobs/${f.jobId}/events`,
      // inject resolves once the handler ends the response; the route closes
      // after one frame when `once` is set, which keeps the test bounded.
      query: { once: '1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const frame = response.payload.trim();
    expect(frame.startsWith('data: ')).toBe(true);
    const event = JSON.parse(frame.slice('data: '.length)) as {
      status: string;
      size: number;
      covered: [number, number][];
    };
    expect(event.status).toBe('ready');
    expect(event.size).toBe(3 * SEG + 400);
    expect(event.covered).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });

  it('404s an unknown job', async () => {
    current = await fixture();
    const response = await current.app.inject({
      method: 'GET',
      url: '/api/jobs/nope/events',
      query: { once: '1' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/jobs/:id/events - a real, disconnecting socket', () => {
  // `inject()` cannot model an open-ended stream: the `once` tests above
  // never exercise the ticking branch at all. This uses a real listening
  // server and a real client so that branch is proven, not assumed — and so
  // a disconnect actually reaches `request.raw`'s `close` event the way a
  // browser tab closing would.
  it('stops polling once the client disconnects', async () => {
    const f = await selected();
    const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
    const getSpy = vi.spyOn(f.store, 'get');

    const destroyClient = await new Promise<() => void>((resolve, reject) => {
      const req = httpGet(`${address}/api/jobs/${f.jobId}/events`, (res) => {
        res.once('data', () => {
          resolve(() => {
            req.destroy();
          });
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
    });

    const callsBeforeDisconnect = getSpy.mock.calls.length;
    destroyClient();

    // The interval ticks every 500ms; waiting past one full period with no
    // growth in `store.get` calls is the only way to show it was actually
    // cleared rather than merely not yet due.
    await new Promise((resolve) => {
      setTimeout(resolve, 800);
    });
    expect(getSpy.mock.calls.length).toBe(callsBeforeDisconnect);
  });
});
