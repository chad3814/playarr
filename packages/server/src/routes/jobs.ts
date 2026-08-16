import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.ts';
import { toJobDto } from '../app.ts';

export const registerJobRoutes: FastifyPluginAsync<{ deps: AppDeps }> = (
  app: FastifyInstance,
  options,
) => {
  const { store, manager } = options.deps;

  app.post('/jobs', async (request, reply) => {
    const upload = await request.file();
    if (upload === undefined) {
      return reply.code(400).send({ code: 'no-file', message: 'Attach an .nzb file.' });
    }

    const bytes = await upload.toBuffer();
    try {
      const record = await store.create(upload.filename, bytes);
      return reply.code(201).send(toJobDto(record, manager.activeId));
    } catch (error) {
      // The parser is strict on purpose and its messages name the problem.
      return reply
        .code(400)
        .send({ code: 'bad-nzb', message: error instanceof Error ? error.message : String(error) });
    }
  });

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
