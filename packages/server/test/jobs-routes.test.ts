import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobDto } from '@playarr/shared';
import { buildApp } from '../src/app.ts';
import { ConfigStore } from '../src/config/store.ts';
import { JobStore } from '../src/jobs/store.ts';
import { JobManager } from '../src/jobs/manager.ts';
import { PoolManager } from '../src/nntp/pool.ts';

const NZB = `<?xml version="1.0" encoding="iso-8859-1" ?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="p@example.com" date="1700000000" subject="[1/1] - &quot;Some.Film.mp4&quot; yEnc (1/2)">
    <groups><group>alt.binaries.test</group></groups>
    <segments>
      <segment bytes="500" number="1">a@example.com</segment>
      <segment bytes="500" number="2">b@example.com</segment>
    </segments>
  </file>
</nzb>`;

let app: FastifyInstance | null = null;

async function makeApp(): Promise<FastifyInstance> {
  const root = await mkdtemp(join(tmpdir(), 'playarr-routes-'));
  const store = new JobStore(join(root, 'jobs'));
  await store.scan();
  const pool = new PoolManager(() => {
    throw new Error('no pool in this test');
  });
  const built = await buildApp({
    store,
    manager: new JobManager(store, pool),
    config: new ConfigStore(join(root, 'config.json')),
    pool,
    env: {},
  });
  app = built;
  return built;
}

/** Fastify's inject accepts a payload + headers; multipart needs a real body. */
function multipart(
  body: string,
  filename: string,
): { payload: string; headers: Record<string, string> } {
  const boundary = '----playarrtest';
  const payload =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="nzb"; filename="${filename}"\r\n` +
    `Content-Type: application/x-nzb\r\n\r\n${body}\r\n--${boundary}--\r\n`;
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('POST /api/jobs', () => {
  it('accepts an NZB and returns its candidates', async () => {
    const server = await makeApp();
    const response = await server.inject({
      method: 'POST',
      url: '/api/jobs',
      ...multipart(NZB, 'release.nzb'),
    });

    expect(response.statusCode).toBe(201);
    const job = response.json<JobDto>();
    expect(job.status).toBe('uploaded');
    expect(job.nzbName).toBe('release.nzb');
    expect(job.active).toBe(false);
    expect(job.candidates).toHaveLength(1);
    expect(job.candidates[0]?.selectable).toBe(true);
  });

  it('rejects a malformed NZB with the parser message', async () => {
    const server = await makeApp();
    const response = await server.inject({
      method: 'POST',
      url: '/api/jobs',
      ...multipart('<nzb><file>', 'bad.nzb'),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('bad-nzb');
  });

  it('rejects a request with no file', async () => {
    const server = await makeApp();
    const response = await server.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'content-type': 'multipart/form-data; boundary=----x' },
      payload: '------x--\r\n',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/jobs', () => {
  it('lists nothing before anything is uploaded', async () => {
    const server = await makeApp();
    const response = await server.inject({ method: 'GET', url: '/api/jobs' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('lists an uploaded job and serves it by id', async () => {
    const server = await makeApp();
    const created = (
      await server.inject({ method: 'POST', url: '/api/jobs', ...multipart(NZB, 'release.nzb') })
    ).json<JobDto>();

    const list = (await server.inject({ method: 'GET', url: '/api/jobs' })).json<JobDto[]>();
    expect(list.map((job) => job.id)).toEqual([created.id]);

    const detail = await server.inject({ method: 'GET', url: `/api/jobs/${created.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<JobDto>().id).toBe(created.id);
  });

  it('404s an unknown job', async () => {
    const server = await makeApp();
    const response = await server.inject({ method: 'GET', url: '/api/jobs/nope' });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/jobs/:id', () => {
  it('removes the job', async () => {
    const server = await makeApp();
    const created = (
      await server.inject({ method: 'POST', url: '/api/jobs', ...multipart(NZB, 'release.nzb') })
    ).json<JobDto>();

    expect(
      (await server.inject({ method: 'DELETE', url: `/api/jobs/${created.id}` })).statusCode,
    ).toBe(204);
    expect(
      (await server.inject({ method: 'GET', url: `/api/jobs/${created.id}` })).statusCode,
    ).toBe(404);
  });

  it('is idempotent', async () => {
    const server = await makeApp();
    const response = await server.inject({ method: 'DELETE', url: '/api/jobs/never-existed' });
    expect(response.statusCode).toBe(204);
  });
});
