import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pino from 'pino';
import { buildApp } from './app.ts';
import { ConfigStore } from './config/store.ts';
import { readEnv } from './env.ts';
import { JobManager } from './jobs/manager.ts';
import { reportToLogger } from './jobs/reporting.ts';
import { JobStore } from './jobs/store.ts';
import { PoolManager } from './nntp/pool.ts';
import { applySettings } from './routes/settings.ts';
import { shutdown } from './shutdown.ts';

const env = readEnv(process.env);

// Live in production: real pino, default level, writing to stdout. Built
// before JobStore/JobManager below so both can log through it from the
// start, rather than through an interim stand-in.
const logger = pino();

const store = new JobStore(
  join(env.dataDir, 'jobs'),
  () => new Date(),
  randomUUID,
  reportToLogger(logger, 'job state write failed'),
);
await store.scan();

const config = new ConfigStore(join(env.dataDir, 'config.json'));
const pool = new PoolManager();
const manager = new JobManager(store, pool, reportToLogger(logger, 'job observer failed'));

const deps = {
  store,
  manager,
  config,
  pool,
  env: process.env,
  logger,
  ...(env.clientDir === undefined ? {} : { clientDir: env.clientDir }),
};

// A missing or unusable provider config must not stop the container: the
// settings page has to be reachable in order to fix it.
await applySettings(deps);

const app = await buildApp(deps);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown({ manager, store, pool, app }).then(() => process.exit());
  });
}

await app.listen({ port: env.port, host: env.host });
console.log(`playarr listening on http://${env.host}:${env.port}`);
