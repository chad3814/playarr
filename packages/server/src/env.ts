export interface ServerEnv {
  readonly dataDir: string;
  readonly port: number;
  readonly host: string;
  readonly clientDir: string | undefined;
}

/**
 * An unset variable and a set-but-blank one both mean "nothing here".
 *
 * `docker-compose.yml` interpolation such as `${PLAYARR_DATA_DIR:-}` injects
 * the empty string whenever a variable is unset on the docker host, so `??`
 * alone would let a blank value silently override a real default.
 */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function readEnv(env: NodeJS.ProcessEnv): ServerEnv {
  const port = Number(env['PORT'] ?? '8080');
  return {
    dataDir: nonEmpty(env['PLAYARR_DATA_DIR']) ?? '/data',
    port: Number.isInteger(port) && port > 0 ? port : 8080,
    host: nonEmpty(env['HOST']) ?? '0.0.0.0',
    clientDir: nonEmpty(env['PLAYARR_CLIENT_DIR']),
  };
}
