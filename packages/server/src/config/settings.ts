import { access } from 'node:fs/promises';
import { chain, fromFile, fromStatic, ProviderError } from '@chad3814/secret-provider';
import type { Provider } from '@chad3814/secret-provider';
import type { NntpSecret } from '@chad3814/nntp';
import type { NntpSecurity, SettingsDto, SettingsUpdate } from '@playarr/shared';

export const SECRET_PASSWORD_PATH = '/run/secret/nntp_password';
export const SECRET_USERNAME_PATH = '/run/secret/nntp_username';

const DEFAULT_PORT = 563;
const DEFAULT_CONNECTIONS = 4;
const SECURITIES: readonly NntpSecurity[] = ['implicit', 'starttls', 'none'];

export interface StoredConfig {
  readonly host: string;
  readonly port: number;
  readonly security: NntpSecurity;
  readonly connections: number;
  readonly username: string;
  /** Present only when the settings page was used. */
  readonly password?: string | undefined;
}

export interface ResolvedSettings {
  readonly host: string;
  readonly port: number;
  readonly security: NntpSecurity;
  readonly connections: number;
  readonly username: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  // Number('eight') is NaN and NaN < 1 is false, so test for integrality first.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function security(value: string | undefined, fallback: NntpSecurity): NntpSecurity {
  return SECURITIES.find((candidate) => candidate === value) ?? fallback;
}

/**
 * An unset variable and a set-but-blank one both mean "nothing here" for a
 * plain string field.
 *
 * `docker-compose.yml` interpolation such as `NNTP_HOST: ${NNTP_HOST:-}`
 * injects the empty string whenever the host variable is unset on the docker
 * host, so treating `''` the same as "absent" is required for the stored
 * config to survive a container restart rather than being silently blanked.
 */
function envString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value;
}

/** Environment beats the volume. Null when no host is configured anywhere. */
export function resolveSettings(
  stored: StoredConfig | null,
  env: NodeJS.ProcessEnv,
): ResolvedSettings | null {
  const host = envString(env['NNTP_HOST']) ?? stored?.host ?? '';
  if (host === '') {
    return null;
  }
  return {
    host,
    port: positiveInteger(env['NNTP_PORT'], stored?.port ?? DEFAULT_PORT),
    security: security(env['NNTP_SECURITY'], stored?.security ?? 'implicit'),
    connections: positiveInteger(
      env['NNTP_CONNECTIONS'],
      stored?.connections ?? DEFAULT_CONNECTIONS,
    ),
    username: envString(env['NNTP_USERNAME']) ?? stored?.username ?? '',
  };
}

/**
 * A `fromEnv`-alike bound to an injected environment rather than the real
 * `process.env`.
 *
 * The package's own `fromEnv` always reads `process.env` regardless of what
 * is passed to either of its overloads, so it cannot be used here: this
 * module takes `env` as a parameter precisely so `resolveSettings` and
 * `describeSettings` are testable without touching the real process
 * environment, and `credentialsFor` needs the same seam for the same reason.
 */
function fromInjectedEnv(env: NodeJS.ProcessEnv, name: string): Provider<string> {
  return () => {
    const value = env[name];
    if (value === undefined) {
      return Promise.reject(new ProviderError(`${name} not set in the environment`));
    }
    if (value === '') {
      return Promise.reject(new ProviderError(`${name} is set but empty`));
    }
    return Promise.resolve(value);
  };
}

/**
 * The CLI's chain minus `fromPrompt`, which has no meaning without a TTY.
 *
 * The pool memoizes whatever it is given, so this makes one trip to the
 * underlying source per pool rather than one per connection.
 */
export function credentialsFor(
  stored: StoredConfig | null,
  env: NodeJS.ProcessEnv,
  secretPaths?: { readonly user: string; readonly pass: string },
): { user: NntpSecret; pass: NntpSecret } {
  const userPath = secretPaths?.user ?? SECRET_USERNAME_PATH;
  const passPath = secretPaths?.pass ?? SECRET_PASSWORD_PATH;
  const storedUser = stored?.username;
  const storedPass = stored?.password;

  const userSources = [fromInjectedEnv(env, 'NNTP_USERNAME'), fromFile(userPath)];
  const passSources = [fromInjectedEnv(env, 'NNTP_PASSWORD'), fromFile(passPath)];
  if (storedUser !== undefined && storedUser !== '') {
    userSources.push(fromStatic(storedUser));
  }
  if (storedPass !== undefined && storedPass !== '') {
    passSources.push(fromStatic(storedPass));
  }

  return {
    user: chain(...userSources),
    pass: chain(...passSources),
  };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The settings DTO. Has no `password` field by construction, not by omission. */
export async function describeSettings(
  stored: StoredConfig | null,
  env: NodeJS.ProcessEnv,
  secretExists: (path: string) => Promise<boolean> = fileExists,
): Promise<SettingsDto | null> {
  const resolved = resolveSettings(stored, env);
  if (resolved === null) {
    return null;
  }
  const fromEnvironment =
    (env['NNTP_PASSWORD'] ?? '') !== '' || (await secretExists(SECRET_PASSWORD_PATH));
  const fromVolume = (stored?.password ?? '') !== '';

  return {
    host: resolved.host,
    port: resolved.port,
    security: resolved.security,
    connections: resolved.connections,
    username: resolved.username,
    hasPassword: fromEnvironment || fromVolume,
    passwordFromEnvironment: fromEnvironment,
  };
}

/** An omitted password leaves the stored one alone; an empty one clears it. */
export function mergeUpdate(stored: StoredConfig | null, update: SettingsUpdate): StoredConfig {
  const password = update.password === undefined ? stored?.password : update.password;
  return {
    host: update.host,
    port: update.port,
    security: update.security,
    connections: update.connections,
    username: update.username,
    ...(password === undefined || password === '' ? {} : { password }),
  };
}
