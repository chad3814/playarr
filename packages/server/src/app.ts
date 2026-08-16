import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { coveredBytes, type JobDto } from '@playarr/shared';
import type { ConfigStore } from './config/store.ts';
import { HttpError } from './errors.ts';
import { deriveCandidates } from './jobs/candidates.ts';
import type { JobManager } from './jobs/manager.ts';
import type { JobRecord, JobStore } from './jobs/store.ts';
import type { PoolManager } from './nntp/pool.ts';
import { registerJobRoutes } from './routes/jobs.ts';
import { registerSelectRoutes } from './routes/select.ts';

export interface AppDeps {
  readonly store: JobStore;
  readonly manager: JobManager;
  readonly config: ConfigStore;
  readonly pool: PoolManager;
  readonly env: NodeJS.ProcessEnv;
  /** Built client assets. Omitted in tests. */
  readonly clientDir?: string;
}

export function toJobDto(record: JobRecord, activeId: string | null): JobDto {
  const { candidates, namesUnresolved } = deriveCandidates(record.nzb);
  const selection = record.state.selection;

  return {
    id: record.state.id,
    createdAt: record.state.createdAt,
    nzbName: record.state.nzbName,
    status: record.state.status,
    active: activeId === record.state.id,
    candidates,
    namesUnresolved,
    ...(record.state.failure === undefined ? {} : { failure: record.state.failure }),
    ...(selection === undefined
      ? {}
      : {
          selection: {
            fileIndex: selection.fileIndex,
            name: selection.name,
            size: selection.size,
            segmentSize: selection.geometry.segmentSize,
            lastSegmentSize: selection.geometry.lastSegmentSize,
            segmentCount: selection.geometry.segmentCount,
            covered: selection.covered,
            dead: selection.dead,
            coveredBytes: coveredBytes(selection.covered, selection.geometry),
          },
        }),
  };
}

/**
 * Whether a rejection is Fastify's own, raised because a body failed its
 * schema. Fastify tags exactly those with `validation`, and nothing else does.
 *
 * Takes `unknown` because that is honestly what reaches an error handler: a
 * route may reject with anything, and Fastify types the parameter the same way.
 */
function isSchemaRejection(error: unknown): error is Error {
  return error instanceof Error && 'validation' in error && Array.isArray(error.validation);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  // NZBs are XML and rarely large; 64 MiB is generous and bounded.
  await app.register(multipart, { limits: { fileSize: 64 * 1_048_576, files: 1 } });

  // Set before any route is registered. A plugin captures the error handler of
  // its parent as its context is created, so one installed afterwards is
  // inherited by nothing and never runs. Anything that is neither an HttpError
  // nor a schema rejection is a server-side fault, and Node's fs errors embed
  // absolute paths, so only a fixed string goes back.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (isSchemaRejection(error)) {
      return reply.code(400).send({ code: 'bad-request', message: error.message });
    }
    app.log.error(error);
    return reply.code(500).send({ code: 'internal', message: 'Something went wrong.' });
  });

  await app.register(registerJobRoutes, { deps, prefix: '/api' });
  await app.register(registerSelectRoutes, { deps, prefix: '/api' });

  if (deps.clientDir !== undefined) {
    await app.register(fastifyStatic, { root: deps.clientDir });
    // Client-side routing: anything not under /api falls back to the shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        void reply.code(404).send({ code: 'not-found', message: 'No such endpoint.' });
        return;
      }
      void reply.sendFile('index.html');
    });
  }

  return app;
}
