import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pino from 'pino';
import { buildApp } from './app.ts';
import { ConfigStore } from './config/store.ts';
import { readEnv } from './env.ts';
import { JobManager } from './jobs/manager.ts';
import { asError, reportToLogger } from './jobs/reporting.ts';
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
    // Caught rather than left bare: an unhandled rejection here aborts the
    // process on the spot, before `process.exit()` and before anything after
    // the failing step has run. A shutdown that cannot finish still has to
    // exit deliberately, and say so through the exit code.
    void shutdown({ manager, store, pool, app })
      .catch((reason: unknown) => {
        logger.error({ err: asError(reason) }, 'shutdown did not complete');
        process.exitCode = 1;
      })
      .then(() => process.exit());
  });
}

await app.listen({ port: env.port, host: env.host });
logger.info({ port: env.port, host: env.host }, 'playarr listening');
