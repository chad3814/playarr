import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { SelectRequest } from '@playarr/shared';
import type { AppDeps } from '../app.ts';
import { toJobDto } from '../app.ts';

const selectSchema = {
  body: {
    type: 'object',
    required: ['fileIndex'],
    additionalProperties: false,
    properties: { fileIndex: { type: 'integer', minimum: 0 } },
  },
} as const;

export const registerSelectRoutes: FastifyPluginAsync<{ deps: AppDeps }> = (
  app: FastifyInstance,
  options,
) => {
  const { manager } = options.deps;

  app.post<{ Params: { id: string }; Body: SelectRequest }>('/jobs/:id/select', {
    schema: selectSchema,
    handler: async (request) => {
      const record = await manager.select(request.params.id, request.body.fileIndex);
      return toJobDto(record, manager.activeId);
    },
  });

  return Promise.resolve();
};
