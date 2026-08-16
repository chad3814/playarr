import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.ts';

describe('readEnv - defaults', () => {
  it('falls back to defaults when nothing is set', () => {
    expect(readEnv({})).toEqual({
      dataDir: '/data',
      port: 8080,
      host: '0.0.0.0',
      clientDir: undefined,
    });
  });

  it('uses whatever is actually set', () => {
    const env = readEnv({
      PLAYARR_DATA_DIR: '/srv/playarr',
      PORT: '9000',
      HOST: '127.0.0.1',
      PLAYARR_CLIENT_DIR: '/srv/client',
    });
    expect(env).toEqual({
      dataDir: '/srv/playarr',
      port: 9000,
      host: '127.0.0.1',
      clientDir: '/srv/client',
    });
  });
});

describe('readEnv - a variable set to the empty string', () => {
  it('treats an empty PLAYARR_DATA_DIR the same as unset, not as ""', () => {
    expect(readEnv({ PLAYARR_DATA_DIR: '' }).dataDir).toBe('/data');
  });

  it('treats an empty HOST the same as unset, not as ""', () => {
    expect(readEnv({ HOST: '' }).host).toBe('0.0.0.0');
  });

  it('treats an empty PLAYARR_CLIENT_DIR as absent rather than as a root to serve', () => {
    expect(readEnv({ PLAYARR_CLIENT_DIR: '' }).clientDir).toBeUndefined();
  });
});

describe('readEnv - PORT', () => {
  it('falls back to 8080 for a non-numeric value', () => {
    expect(readEnv({ PORT: 'eight thousand' }).port).toBe(8080);
  });

  it('falls back to 8080 for a zero or negative value', () => {
    expect(readEnv({ PORT: '0' }).port).toBe(8080);
    expect(readEnv({ PORT: '-1' }).port).toBe(8080);
  });

  it('falls back to 8080 when PORT is set but empty', () => {
    expect(readEnv({ PORT: '' }).port).toBe(8080);
  });
});
