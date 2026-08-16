import { NzbParseError } from '@chad3814/nzb-parser';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.ts';
import { toJobDto } from '../app.ts';
import { asError } from '../jobs/reporting.ts';
import type { JobManager } from '../jobs/manager.ts';
import type { JobStore } from '../jobs/store.ts';

async function uploadJob(
  store: JobStore,
  manager: JobManager,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const upload = await request.file();
  if (upload === undefined) {
    return reply.code(400).send({ code: 'no-file', message: 'Attach an .nzb file.' });
  }

  const bytes = await upload.toBuffer();
  try {
    const record = await store.create(upload.filename, bytes);
    return reply.code(201).send(toJobDto(record, manager.activeId));
  } catch (error) {
    if (error instanceof NzbParseError) {
      // The parser is strict on purpose and its messages name the problem.
      return reply.code(400).send({ code: 'bad-nzb', message: error.message });
    }
    // Anything past the parse is a server-side failure (disk full,
    // permissions, ...): Node's fs errors embed absolute paths, so none of
    // that detail belongs in a public response body. It does belong in the
    // log — without this line a full or read-only /data is invisible to the
    // operator, who sees only uploads that fail for no stated reason.
    request.log.error({ err: asError(error) }, 'saving an uploaded NZB failed');
    return reply
      .code(500)
      .send({ code: 'upload-failed', message: 'The upload could not be saved.' });
  }
}

export const registerJobRoutes: FastifyPluginAsync<{ deps: AppDeps }> = (
  app: FastifyInstance,
  options,
) => {
  const { store, manager } = options.deps;

  app.post('/jobs', (request, reply) => uploadJob(store, manager, request, reply));

  app.get('/jobs', () => store.list().map((record) => toJobDto(record, manager.activeId)));

  app.get<{ Params: { id: string } }>('/jobs/:id', (request, reply) => {
    const record = store.get(request.params.id);
    if (record === undefined) {
      return reply.code(404).send({ code: 'not-found', message: 'No such job.' });
    }
    return toJobDto(record, manager.activeId);
  });

  app.delete<{ Params: { id: string } }>('/jobs/:id', async (request, reply) => {
    await manager.release(request.params.id);
    await store.remove(request.params.id);
    return reply.code(204).send();
  });

  return Promise.resolve();
};
