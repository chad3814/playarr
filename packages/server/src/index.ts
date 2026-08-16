import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { buildApp } from './app.ts';
import { ConfigStore } from './config/store.ts';
import { readEnv } from './env.ts';
import { JobManager } from './jobs/manager.ts';
import { asError } from './jobs/reporting.ts';
import { JobStore } from './jobs/store.ts';
import { PoolManager } from './nntp/pool.ts';
import { applySettings } from './routes/settings.ts';

const env = readEnv(process.env);

/**
 * Where a background job failure goes.
 *
 * `JobStore` and `JobManager` are constructed below before the Fastify app
 * exists, so there is no `app.log` yet to hand them. This starts out writing
 * to stderr — the same interim `reportToStderr` used, so nothing is lost in
 * the narrow startup window — and is replaced with the real logger the
 * moment `buildApp` returns, before the server accepts any request that
 * could trigger it.
 */
let reportJobError: (context: string, jobId: string, error: Error) => void = (
  context,
  jobId,
  error,
) => {
  process.stderr.write(`playarr: ${context} (job ${jobId}): ${error.stack ?? error.message}\n`);
};

const store = new JobStore(
  join(env.dataDir, 'jobs'),
  () => new Date(),
  randomUUID,
  (jobId, error) => reportJobError('job state write failed', jobId, error),
);
await store.scan();

const config = new ConfigStore(join(env.dataDir, 'config.json'));
const pool = new PoolManager();
const manager = new JobManager(store, pool, (jobId, error) =>
  reportJobError('job observer failed', jobId, error),
);

const deps = {
  store,
  manager,
  config,
  pool,
  env: process.env,
  ...(env.clientDir === undefined ? {} : { clientDir: env.clientDir }),
};

// A missing or unusable provider config must not stop the container: the
// settings page has to be reachable in order to fix it.
await applySettings(deps);

const app = await buildApp(deps);
reportJobError = (context, jobId, error) => {
  app.log.error({ jobId, err: error }, context);
};

async function shutdown(): Promise<void> {
  await manager.releaseAll();
  await store.dispose().catch((reason: unknown) => {
    // dispose() rejects with an AggregateError naming every job whose state
    // did not reach disk. A shutdown is the one caller who can judge whether
    // that loss matters, so it is logged rather than swallowed, and a
    // non-zero exit code carries the failure to whatever is supervising this
    // process — blocking any longer here cannot recover a write that has
    // already failed.
    app.log.error({ err: asError(reason) }, 'job state was not fully flushed during shutdown');
    process.exitCode = 1;
  });
  await pool.destroy();
  await app.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown().then(() => process.exit());
  });
}

await app.listen({ port: env.port, host: env.host });
console.log(`playarr listening on http://${env.host}:${env.port}`);
