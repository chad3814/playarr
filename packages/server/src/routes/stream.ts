import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.ts';
import type { Download } from '../download/download.ts';
import { HttpError } from '../errors.ts';
import type { JobStore } from '../jobs/store.ts';
import { parseRangeHeader, type ParsedRange } from './range.ts';

function sizeOf(store: JobStore, id: string): number {
  const record = store.get(id);
  if (record === undefined) {
    throw new HttpError(404, 'not-found', 'No such job.');
  }
  if (record.state.selection === undefined) {
    throw new HttpError(409, 'not-selected', 'Choose a file in this NZB first.');
  }
  return record.state.selection.size;
}

function unsatisfiable(reply: FastifyReply, size: number): FastifyReply {
  return reply
    .header('accept-ranges', 'bytes')
    .header('content-range', `bytes */${size}`)
    .code(416)
    .send({ code: 'unsatisfiable-range', message: 'That range is outside the file.' });
}

/**
 * A reader that goes away must stop waiting, but must not stop the fetcher —
 * Chrome aborts and re-requests constantly, and the download has to survive it.
 */
function abortOn(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.on('close', () => controller.abort());
  return controller.signal;
}

function bodyFor(chunks: AsyncGenerator<Uint8Array>, request: FastifyRequest): Readable {
  const stream = Readable.from(chunks);
  request.raw.on('close', () => stream.destroy());
  return stream;
}

function streamRange(
  download: Download,
  parsed: Exclude<ParsedRange, { kind: 'unsatisfiable' }>,
  size: number,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const start = parsed.kind === 'full' ? 0 : parsed.start;
  const end = parsed.kind === 'full' ? size : parsed.end;

  reply
    .header('accept-ranges', 'bytes')
    .header('content-type', 'video/mp4')
    .header('content-length', String(end - start))
    .header('cache-control', 'no-store');

  if (parsed.kind === 'partial') {
    reply.header('content-range', `bytes ${start}-${end - 1}/${size}`).code(206);
  } else {
    reply.code(200);
  }

  return reply.send(bodyFor(download.read(start, end, abortOn(request)), request));
}

export const registerStreamRoutes: FastifyPluginAsync<{ deps: AppDeps }> = (
  app: FastifyInstance,
  options,
) => {
  const { store, manager } = options.deps;

  app.head<{ Params: { id: string } }>('/jobs/:id/stream', (request, reply) => {
    const size = sizeOf(store, request.params.id);
    return reply
      .header('accept-ranges', 'bytes')
      .header('content-type', 'video/mp4')
      .header('content-length', String(size))
      .code(200)
      .send();
  });

  app.get<{ Params: { id: string } }>('/jobs/:id/stream', async (request, reply) => {
    const size = sizeOf(store, request.params.id);
    const parsed = parseRangeHeader(request.headers.range, size);

    if (parsed.kind === 'unsatisfiable') {
      return unsatisfiable(reply, size);
    }

    // Makes this job the active one if it is not already; a no-op when it is.
    const download = await manager.activate(request.params.id);
    return streamRange(download, parsed, size, request, reply);
  });

  return Promise.resolve();
};
