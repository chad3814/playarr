import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DownloadConflict, JobDto, ProgressEvent } from '@playarr/shared';
import type { AppDeps } from '../app.ts';
import { toJobDto } from '../app.ts';
import { HttpError } from '../errors.ts';
import type { JobManager } from '../jobs/manager.ts';
import { asError } from '../jobs/reporting.ts';
import type { JobSelection } from '../jobs/state.ts';
import type { JobRecord, JobStore } from '../jobs/store.ts';

export const PROGRESS_INTERVAL_MS = 500;

type CompleteRequest = FastifyRequest<{ Params: { id: string } }>;

interface Selected {
  readonly record: JobRecord;
  readonly selection: JobSelection;
}

function selected(store: JobStore, id: string): Selected {
  const record = store.get(id);
  if (record === undefined) {
    throw new HttpError(404, 'not-found', 'No such job.');
  }
  const selection = record.state.selection;
  if (selection === undefined) {
    throw new HttpError(409, 'not-selected', 'Choose a file in this NZB first.');
  }
  return { record, selection };
}

/** Fetchable holes left in the file: neither on disk nor given up on as dead. */
function missingCount(selection: JobSelection): number {
  const covered = selection.covered.reduce((sum, [start, end]) => sum + (end - start), 0);
  return Math.max(0, selection.geometry.segmentCount - covered - selection.dead.length);
}

function progressOf(
  manager: JobManager,
  record: JobRecord,
  selection: JobSelection,
): ProgressEvent {
  const dto = toJobDto(record, manager.activeId);
  const download = manager.activeId === record.state.id ? manager.active() : null;

  return {
    status: record.state.status,
    covered: selection.covered,
    dead: selection.dead,
    coveredBytes: dto.selection?.coveredBytes ?? 0,
    size: selection.size,
    bytesPerSecond: download?.bytesPerSecond ?? 0,
  };
}

/** Write one progress frame, or nothing once the job or its selection is gone. */
function sendProgress(store: JobStore, manager: JobManager, id: string, reply: FastifyReply): void {
  const record = store.get(id);
  const selection = record?.state.selection;
  if (record === undefined || selection === undefined) {
    return;
  }
  reply.raw.write(`data: ${JSON.stringify(progressOf(manager, record, selection))}\n\n`);
}

/**
 * Fill every fetchable hole and durably mark the job complete.
 *
 * The fetcher's own `onDrained` observer may already have raced this to
 * 'complete' the instant the last segment landed, but that write is
 * fire-and-forget from the fetcher's point of view. This re-sets and flushes
 * 'complete' unconditionally (unless the download died) so the response is
 * never sent ahead of the state that backs it.
 */
async function completeJob(
  store: JobStore,
  manager: JobManager,
  request: CompleteRequest,
): Promise<JobDto> {
  const id = request.params.id;
  const { record } = selected(store, id);
  const download = await manager.activate(record.state.id);

  await store.update(record.state.id, { ...record.state, status: 'completing' }, { flush: true });
  try {
    await download.completeAll();
  } catch (error) {
    await abandonCompletion(store, request);
    throw error;
  }

  const after = selected(store, record.state.id).record;
  if (after.state.status !== 'failed') {
    await store.update(after.state.id, { ...after.state, status: 'complete' }, { flush: true });
  }
  return toJobDto(selected(store, record.state.id).record, manager.activeId);
}

/**
 * Put a job whose fill did not finish back into a status the UI can act on.
 *
 * 'completing' is a status with nothing behind it: the finished dialog's
 * Download and Delete buttons are the only affordances, and neither offers a
 * way back out of a fill that has already stopped. So a job left there is
 * stuck until the container restarts. 'paused' is what the job actually is.
 *
 * A fatal download failure has already written 'failed', which is truer than
 * anything here, so that is left alone. The restore's own failure is logged
 * and swallowed: the caller is about to rethrow the reason the fill failed,
 * and that is the more useful of the two.
 */
async function abandonCompletion(store: JobStore, request: CompleteRequest): Promise<void> {
  const record = store.get(request.params.id);
  if (record === undefined || record.state.status !== 'completing') {
    return;
  }
  await store
    .update(record.state.id, { ...record.state, status: 'paused' }, { flush: true })
    .catch((reason: unknown) => {
      request.log.error({ err: asError(reason) }, 'a job could not be moved out of completing');
    });
}

/**
 * Serve the finished file, or 409 with how many segments still stand between
 * here and finished.
 *
 * Reads through `store.outputPath`, not a bare join: `selection.name` came
 * back off the volume (state.json), which is the one place a hand-edited
 * state could aim a read outside the job directory.
 */
function downloadJob(store: JobStore, id: string, reply: FastifyReply): FastifyReply {
  const { record, selection } = selected(store, id);

  if (record.state.status !== 'complete') {
    const conflict: DownloadConflict = { missing: missingCount(selection) };
    return reply.code(409).send(conflict);
  }

  return reply
    .header('content-type', 'video/mp4')
    .header('content-length', String(selection.size))
    .header('content-disposition', `attachment; filename="${selection.name.replaceAll('"', '')}"`)
    .send(createReadStream(store.outputPath(record)));
}

type EventsRequest = FastifyRequest<{ Params: { id: string }; Querystring: { once?: string } }>;

/**
 * Stream progress as SSE, one frame immediately and then one per tick until
 * the client goes away.
 *
 * Returns `void`, not `reply`: the route below never returns this function's
 * result, so Fastify's dispatcher (`result !== undefined` in
 * `handle-request.js`) never calls `reply.send()` on our behalf. That send
 * would be a second, unwanted one — `reply.raw` is already being written to
 * directly — and unlike a plain "already sent" no-op, a truthy payload here
 * carries no recognised content-type until `raw.end()` has actually run, so
 * Fastify would try to JSON-serialise a payload it cannot: `FST_ERR_REP_INVALID_PAYLOAD_TYPE`.
 * Confirmed against a real listening server in delivery.test.ts.
 */
function streamEvents(
  store: JobStore,
  manager: JobManager,
  request: EventsRequest,
  reply: FastifyReply,
): void {
  const { record } = selected(store, request.params.id);

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  sendProgress(store, manager, record.state.id, reply);

  if (request.query.once === '1') {
    reply.raw.end();
    return;
  }

  const timer = setInterval(() => {
    sendProgress(store, manager, record.state.id, reply);
  }, PROGRESS_INTERVAL_MS);

  // The subscription this route owns is the timer, not anything shared, so
  // cleaning it up here rather than trusting Fastify's own teardown is what
  // keeps a stalled client from leaving it ticking forever.
  request.raw.on('close', () => {
    clearInterval(timer);
    reply.raw.end();
  });
}

export const registerDeliveryRoutes: FastifyPluginAsync<{ deps: AppDeps }> = (
  app: FastifyInstance,
  options,
) => {
  const { store, manager } = options.deps;

  app.post<{ Params: { id: string } }>('/jobs/:id/complete', (request) =>
    completeJob(store, manager, request),
  );

  app.get<{ Params: { id: string } }>('/jobs/:id/download', (request, reply) =>
    downloadJob(store, request.params.id, reply),
  );

  app.get<{ Params: { id: string }; Querystring: { once?: string } }>(
    '/jobs/:id/events',
    (request, reply) => {
      streamEvents(store, manager, request, reply);
    },
  );

  return Promise.resolve();
};
