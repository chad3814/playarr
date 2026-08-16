import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { reportToLogger } from '../src/jobs/reporting.ts';

/** The one method `reportToLogger` calls. */
function fakeLogger(): {
  logger: Pick<FastifyBaseLogger, 'error'>;
  error: ReturnType<typeof vi.fn<FastifyBaseLogger['error']>>;
} {
  const error = vi.fn<FastifyBaseLogger['error']>();
  return { logger: { error }, error };
}

describe('reportToLogger', () => {
  it('logs the job id and error under the given context', () => {
    const { logger, error } = fakeLogger();
    const failure = new Error('ENOSPC');

    reportToLogger(logger, 'ctx')('job1', failure);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({ jobId: 'job1', err: failure }, 'ctx');
  });

  it('tags each reporter it builds with its own fixed context', () => {
    const { logger, error } = fakeLogger();
    const writeFailure = new Error('EACCES');
    const observerFailure = new Error('boom');

    reportToLogger(logger, 'job state write failed')('job1', writeFailure);
    reportToLogger(logger, 'job observer failed')('job2', observerFailure);

    expect(error).toHaveBeenNthCalledWith(
      1,
      { jobId: 'job1', err: writeFailure },
      'job state write failed',
    );
    expect(error).toHaveBeenNthCalledWith(
      2,
      { jobId: 'job2', err: observerFailure },
      'job observer failed',
    );
  });
});
