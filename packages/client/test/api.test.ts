import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, deleteJob, listJobs, uploadNzb } from '../src/api.ts';

const JOB = {
  id: 'job1',
  createdAt: '2026-08-10T00:00:00.000Z',
  nzbName: 'release.nzb',
  status: 'uploaded',
  active: false,
  candidates: [],
  namesUnresolved: false,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listJobs', () => {
  it('returns a validated array of jobs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, [JOB]));
    const jobs = await listJobs();
    expect(jobs).toEqual([JOB]);
  });

  it('rejects a body that does not look like a job array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, [{ nope: true }]));
    await expect(listJobs()).rejects.toThrow(ApiRequestError);
  });
});

describe('error responses', () => {
  it('carries the server-provided code and message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(404, { code: 'not-found', message: 'No such job.' }),
    );
    const failure = await listJobs().catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ApiRequestError);
    const apiError = failure as ApiRequestError;
    expect(apiError.status).toBe(404);
    expect(apiError.code).toBe('not-found');
    expect(apiError.message).toBe('No such job.');
  });

  it('falls back to a defined code and status when the body is not valid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>gateway error</html>', {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );

    const failure = await listJobs().catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ApiRequestError);
    const apiError = failure as ApiRequestError;
    expect(apiError.status).toBe(502);
    expect(apiError.code).toBe('error');
    expect(apiError.message).toBe('Bad Gateway');
  });

  it('never produces an undefined code or status from an empty JSON error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(500, {}));
    const failure = await listJobs().catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ApiRequestError);
    const apiError = failure as ApiRequestError;
    expect(apiError.status).toBe(500);
    expect(apiError.code).toBe('error');
    expect(typeof apiError.message).toBe('string');
  });
});

describe('uploadNzb', () => {
  it('sends the file as multipart form data and never logs the body', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(201, JOB));

    const file = new File(['<nzb></nzb>'], 'release.nzb', { type: 'application/x-nzb' });
    const job = await uploadNzb(file);

    expect(job).toEqual(JOB);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.body).toBeInstanceOf(FormData);
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

describe('deleteJob', () => {
  it('resolves with no value on a 204', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deleteJob('job1')).resolves.toBeUndefined();
  });
});
