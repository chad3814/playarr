import { afterEach, describe, expect, it } from 'vitest';
import { closeFixture, fixture, type Fixture } from './app-fixture.ts';

const SEG = 1_000;
let current: Fixture | null = null;

async function selected(): Promise<Fixture> {
  current = await fixture({ sizes: [SEG, SEG, SEG, 400] });
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

describe('GET /api/jobs/:id/stream - full and partial reads', () => {
  it('advertises range support and the full length on a bare GET', async () => {
    const f = await selected();
    const response = await f.app.inject({ method: 'GET', url: `/api/jobs/${f.jobId}/stream` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(Number(response.headers['content-length'])).toBe(3 * SEG + 400);
    expect(Buffer.from(response.rawPayload).equals(f.post.data)).toBe(true);
  });

  it('answers a range request with 206 and a correct Content-Range', async () => {
    const f = await selected();
    const response = await f.app.inject({
      method: 'GET',
      url: `/api/jobs/${f.jobId}/stream`,
      headers: { range: 'bytes=0-499' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 0-499/${3 * SEG + 400}`);
    expect(Number(response.headers['content-length'])).toBe(500);
    expect(Buffer.from(response.rawPayload).equals(f.post.data.subarray(0, 500))).toBe(true);
  });

  it('serves an open-ended range, which is what Chrome sends', async () => {
    const f = await selected();
    const size = 3 * SEG + 400;
    const response = await f.app.inject({
      method: 'GET',
      url: `/api/jobs/${f.jobId}/stream`,
      headers: { range: 'bytes=1500-' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 1500-${size - 1}/${size}`);
    expect(Buffer.from(response.rawPayload).equals(f.post.data.subarray(1_500))).toBe(true);
  });

  it('serves a range spanning a segment boundary', async () => {
    const f = await selected();
    const response = await f.app.inject({
      method: 'GET',
      url: `/api/jobs/${f.jobId}/stream`,
      headers: { range: 'bytes=900-1099' },
    });
    expect(Buffer.from(response.rawPayload).equals(f.post.data.subarray(900, 1_100))).toBe(true);
  });
});

describe('GET /api/jobs/:id/stream - edges', () => {
  it('serves the tail from primed coverage without fetching anything', async () => {
    const f = await selected();
    const before = f.source.requestCount;
    const size = 3 * SEG + 400;

    const response = await f.app.inject({
      method: 'GET',
      url: `/api/jobs/${f.jobId}/stream`,
      headers: { range: `bytes=${3 * SEG}-` },
    });

    expect(response.statusCode).toBe(206);
    expect(Buffer.from(response.rawPayload).equals(f.post.data.subarray(3 * SEG, size))).toBe(true);
    expect(f.source.requestCount).toBe(before);
  });

  it('416s a range past the end of the file', async () => {
    const f = await selected();
    const size = 3 * SEG + 400;
    const response = await f.app.inject({
      method: 'GET',
      url: `/api/jobs/${f.jobId}/stream`,
      headers: { range: `bytes=${size}-` },
    });

    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe(`bytes */${size}`);
  });

  it('answers HEAD with the headers and no body', async () => {
    const f = await selected();
    const response = await f.app.inject({ method: 'HEAD', url: `/api/jobs/${f.jobId}/stream` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(Number(response.headers['content-length'])).toBe(3 * SEG + 400);
    expect(response.rawPayload).toHaveLength(0);
  });
});

describe('GET /api/jobs/:id/stream - rejected requests', () => {
  it('409s a job with no selected file', async () => {
    current = await fixture();
    const response = await current.app.inject({
      method: 'GET',
      url: `/api/jobs/${current.jobId}/stream`,
    });
    expect(response.statusCode).toBe(409);
  });

  it('404s an unknown job', async () => {
    current = await fixture();
    const response = await current.app.inject({ method: 'GET', url: '/api/jobs/nope/stream' });
    expect(response.statusCode).toBe(404);
  });
});
