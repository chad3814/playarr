import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { SettingsUpdate } from '@playarr/shared';
import type { AppDeps } from '../app.ts';
import {
  credentialsFor,
  describeSettings,
  mergeUpdate,
  resolveSettings,
} from '../config/settings.ts';

const updateSchema = {
  body: {
    type: 'object',
    required: ['host', 'port', 'security', 'connections', 'username'],
    additionalProperties: false,
    properties: {
      host: { type: 'string', minLength: 1 },
      port: { type: 'integer', minimum: 1, maximum: 65_535 },
      security: { type: 'string', enum: ['implicit', 'starttls', 'none'] },
      connections: { type: 'integer', minimum: 1, maximum: 100 },
      username: { type: 'string' },
      password: { type: 'string' },
    },
  },
} as const;

/** Load the stored config, overlay the environment, and (re)build the pool. */
export async function applySettings(deps: AppDeps): Promise<void> {
  const stored = await deps.config.load();
  const resolved = resolveSettings(stored, deps.env);
  if (resolved === null) {
    return;
  }
  deps.pool.configure(resolved, credentialsFor(stored, deps.env));
}

export const registerSettingsRoutes: FastifyPluginAsync<{ deps: AppDeps }> = (
  app: FastifyInstance,
  options,
) => {
  const { deps } = options;

  app.get('/settings', async () => describeSettings(await deps.config.load(), deps.env));

  app.put<{ Body: SettingsUpdate }>('/settings', {
    schema: updateSchema,
    handler: async (request) => {
      const stored = await deps.config.load();
      const merged = mergeUpdate(stored, request.body);
      await deps.config.save(merged);

      // Reconfiguring destroys the old pool, so anything mid-fetch stops first.
      await deps.manager.releaseAll();
      await applySettings(deps);

      return describeSettings(merged, deps.env);
    },
  });

  app.post('/settings/test', () => deps.pool.test());

  return Promise.resolve();
};
