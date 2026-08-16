import { afterEach, describe, expect, it } from 'vitest';
import type { SettingsDto } from '@playarr/shared';
import { closeFixture, fixture, type Fixture } from './app-fixture.ts';

let current: Fixture | null = null;

afterEach(async () => {
  await closeFixture(current);
  current = null;
});

const valid = {
  host: 'news.example.com',
  port: 563,
  security: 'implicit',
  connections: 8,
  username: 'someone',
  password: 'hunter2',
};

describe('GET /api/settings', () => {
  it('returns null when nothing is configured', async () => {
    current = await fixture({ configured: false });
    const response = await current.app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });
});

describe('PUT /api/settings - storing and reading back', () => {
  it('stores the settings and never echoes the password', async () => {
    current = await fixture({ configured: false });
    const response = await current.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: valid,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain('hunter2');
    const dto = response.json<SettingsDto>();
    expect(dto.host).toBe('news.example.com');
    expect(dto.hasPassword).toBe(true);
    expect(dto.passwordFromEnvironment).toBe(false);
    expect(Object.keys(dto)).not.toContain('password');
  });

  it('does not leak the password on a subsequent GET', async () => {
    current = await fixture({ configured: false });
    await current.app.inject({ method: 'PUT', url: '/api/settings', payload: valid });

    const response = await current.app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.payload).not.toContain('hunter2');
    expect(response.json<SettingsDto>().hasPassword).toBe(true);
  });

  it('keeps the stored password when an update omits one', async () => {
    current = await fixture({ configured: false });
    await current.app.inject({ method: 'PUT', url: '/api/settings', payload: valid });

    const { password: _omitted, ...withoutPassword } = valid;
    const response = await current.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...withoutPassword, host: 'other.example.com' },
    });

    const dto = response.json<SettingsDto>();
    expect(dto.host).toBe('other.example.com');
    expect(dto.hasPassword).toBe(true);
  });
});

describe('PUT /api/settings - validation', () => {
  it('rejects an unknown security mode rather than coercing it', async () => {
    current = await fixture({ configured: false });
    const response = await current.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...valid, security: 'magic' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a connections count below one', async () => {
    current = await fixture({ configured: false });
    const response = await current.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...valid, connections: 0 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an empty host', async () => {
    current = await fixture({ configured: false });
    const response = await current.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...valid, host: '' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/settings/test', () => {
  it('reports unconfigured before anything is set', async () => {
    current = await fixture({ configured: false });
    const response = await current.app.inject({ method: 'POST', url: '/api/settings/test' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(false);
  });

  it('reports success against a working pool', async () => {
    current = await fixture();
    const response = await current.app.inject({ method: 'POST', url: '/api/settings/test' });
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
  });
});
