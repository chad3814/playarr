import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NntpSecret } from '@chad3814/nntp';
import { ConfigStore } from '../src/config/store.ts';
import {
  credentialsFor,
  describeSettings,
  mergeUpdate,
  resolveSettings,
  type StoredConfig,
} from '../src/config/settings.ts';

const stored: StoredConfig = {
  host: 'stored.example.com',
  port: 563,
  security: 'implicit',
  connections: 8,
  username: 'stored-user',
  password: 'stored-secret',
};

const noSecrets = (): Promise<boolean> => Promise.resolve(false);
const allSecrets = (): Promise<boolean> => Promise.resolve(true);

// `Provider<T>` is `() => Promise<T>` — a plain callable, not an object with
// a `.get()` method. `NntpSecret` is `string | Provider<string>`, so a
// `typeof` narrow is enough and no cast is needed.
function resolve(secret: NntpSecret): Promise<string> {
  if (typeof secret === 'string') {
    throw new TypeError('expected a provider, got a literal');
  }
  return secret();
}

describe('ConfigStore', () => {
  it('returns null before anything has been saved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playarr-config-'));
    const store = new ConfigStore(join(dir, 'config.json'));
    expect(await store.load()).toBeNull();
  });

  it('round-trips a config and writes it 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playarr-config-'));
    const path = join(dir, 'config.json');
    const store = new ConfigStore(path);
    await store.save(stored);

    expect(await store.load()).toEqual(stored);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('treats an unreadable config as absent rather than throwing at boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playarr-config-'));
    const path = join(dir, 'config.json');
    const store = new ConfigStore(path);
    await store.save(stored);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'not json', 'utf8');
    expect(await store.load()).toBeNull();
  });
});

describe('resolveSettings', () => {
  it('returns null when nothing is configured anywhere', () => {
    expect(resolveSettings(null, {})).toBeNull();
  });

  it('uses the stored config when the environment is empty', () => {
    expect(resolveSettings(stored, {})).toEqual({
      host: 'stored.example.com',
      port: 563,
      security: 'implicit',
      connections: 8,
      username: 'stored-user',
    });
  });

  it('lets the environment override every stored field', () => {
    const resolved = resolveSettings(stored, {
      NNTP_HOST: 'env.example.com',
      NNTP_PORT: '119',
      NNTP_SECURITY: 'starttls',
      NNTP_CONNECTIONS: '20',
      NNTP_USERNAME: 'env-user',
    });
    expect(resolved).toEqual({
      host: 'env.example.com',
      port: 119,
      security: 'starttls',
      connections: 20,
      username: 'env-user',
    });
  });

  it('works from the environment alone, with no stored config', () => {
    expect(resolveSettings(null, { NNTP_HOST: 'env.example.com' })).toEqual({
      host: 'env.example.com',
      port: 563,
      security: 'implicit',
      connections: 4,
      username: '',
    });
  });

  it('ignores an unusable NNTP_CONNECTIONS rather than passing NaN to the pool', () => {
    const resolved = resolveSettings(stored, { NNTP_CONNECTIONS: 'eight' });
    expect(resolved?.connections).toBe(8);
  });
});

describe('describeSettings', () => {
  it('never includes the password', async () => {
    const dto = await describeSettings(stored, {}, noSecrets);
    expect(dto).not.toBeNull();
    expect(Object.keys(dto!)).not.toContain('password');
    expect(JSON.stringify(dto)).not.toContain('stored-secret');
  });

  it('reports a stored password as present but not from the environment', async () => {
    const dto = await describeSettings(stored, {}, noSecrets);
    expect(dto?.hasPassword).toBe(true);
    expect(dto?.passwordFromEnvironment).toBe(false);
  });

  it('reports an environment password as taking precedence', async () => {
    const dto = await describeSettings(stored, { NNTP_PASSWORD: 'env-secret' }, noSecrets);
    expect(dto?.hasPassword).toBe(true);
    expect(dto?.passwordFromEnvironment).toBe(true);
  });

  it('counts a mounted secret file as an environment password', async () => {
    const dto = await describeSettings({ ...stored, password: undefined }, {}, allSecrets);
    expect(dto?.hasPassword).toBe(true);
    expect(dto?.passwordFromEnvironment).toBe(true);
  });

  it('reports no password when there is none anywhere', async () => {
    const dto = await describeSettings({ ...stored, password: undefined }, {}, noSecrets);
    expect(dto?.hasPassword).toBe(false);
  });
});

describe('credentialsFor', () => {
  it('prefers the environment over the stored password', async () => {
    const { pass } = credentialsFor(stored, { NNTP_PASSWORD: 'env-secret' });
    await expect(resolve(pass)).resolves.toBe('env-secret');
  });

  it('falls back to the stored password when nothing else answers', async () => {
    const { pass } = credentialsFor(stored, {});
    await expect(resolve(pass)).resolves.toBe('stored-secret');
  });

  it('prefers the environment username over the stored one', async () => {
    const { user } = credentialsFor(stored, { NNTP_USERNAME: 'env-user' });
    await expect(resolve(user)).resolves.toBe('env-user');
  });

  it('rejects when no source can supply a password', async () => {
    // Every source in the chain is absent, so ProviderError propagates
    // untouched — its aggregated list names each source that was tried, which
    // is what makes a misconfiguration diagnosable.
    const { pass } = credentialsFor({ ...stored, password: undefined }, {});
    await expect(resolve(pass)).rejects.toThrow();
  });
});

describe('mergeUpdate', () => {
  it('keeps the stored password when the update omits one', () => {
    const merged = mergeUpdate(stored, {
      host: 'new.example.com',
      port: 563,
      security: 'implicit',
      connections: 4,
      username: 'new-user',
    });
    expect(merged.password).toBe('stored-secret');
    expect(merged.host).toBe('new.example.com');
  });

  it('replaces the password when the update supplies one', () => {
    const merged = mergeUpdate(stored, {
      host: 'stored.example.com',
      port: 563,
      security: 'implicit',
      connections: 8,
      username: 'stored-user',
      password: 'replacement',
    });
    expect(merged.password).toBe('replacement');
  });

  it('clears the password when the update supplies an empty string', () => {
    const merged = mergeUpdate(stored, {
      host: 'stored.example.com',
      port: 563,
      security: 'implicit',
      connections: 8,
      username: 'stored-user',
      password: '',
    });
    expect(merged.password).toBeUndefined();
  });
});
