import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsDto, SettingsUpdate } from '@playarr/shared';
import { SettingsDialog } from '../src/components/SettingsDialog.tsx';

const settings: SettingsDto = {
  host: 'news.example.com',
  port: 563,
  security: 'implicit',
  connections: 8,
  username: 'someone',
  hasPassword: true,
  passwordFromEnvironment: false,
};

describe('SettingsDialog password field', () => {
  it('never prefills the password field', () => {
    render(
      <SettingsDialog settings={settings} onSave={vi.fn()} onTest={vi.fn()} onClose={vi.fn()} />,
    );
    const field = screen.getByLabelText(/password/iu) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.type).toBe('password');
    expect(screen.getByText(/a password is already stored/iu)).toBeDefined();
  });

  it('says the credential comes from the environment when it does', () => {
    render(
      <SettingsDialog
        settings={{ ...settings, passwordFromEnvironment: true }}
        onSave={vi.fn()}
        onTest={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/from the environment/iu)).toBeDefined();
  });
});

describe('SettingsDialog saving the password', () => {
  it('omits the password from the update when the field is left blank', async () => {
    const onSave = vi.fn((_update: SettingsUpdate) => Promise.resolve(settings));
    render(
      <SettingsDialog settings={settings} onSave={onSave} onTest={vi.fn()} onClose={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /save/iu }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('password');
  });

  it('sends the password when one is typed', async () => {
    const onSave = vi.fn((_update: SettingsUpdate) => Promise.resolve(settings));
    render(
      <SettingsDialog settings={settings} onSave={onSave} onTest={vi.fn()} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText(/password/iu), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /save/iu }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ password: 'hunter2' });
  });
});

describe('SettingsDialog connection test', () => {
  it('lists the pool per-attempt failures so a connection cap is visible', async () => {
    const onTest = vi.fn(() =>
      Promise.resolve({
        ok: true,
        message: 'Connected to news.example.com:563.',
        failures: ['502 Too many connections'],
      }),
    );
    render(
      <SettingsDialog settings={settings} onSave={vi.fn()} onTest={onTest} onClose={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /test/iu }));
    expect(await screen.findByText('502 Too many connections')).toBeDefined();
  });

  it('shows the result of a connection test', async () => {
    const onTest = vi.fn(() =>
      Promise.resolve({
        ok: false,
        message: '481 Authentication failed',
        failures: [],
      }),
    );
    render(
      <SettingsDialog settings={settings} onSave={vi.fn()} onTest={onTest} onClose={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /test/iu }));
    expect(await screen.findByText(/481 Authentication failed/u)).toBeDefined();
  });
});

describe('SettingsDialog defaults', () => {
  it('starts from sensible defaults when nothing is configured', () => {
    render(<SettingsDialog settings={null} onSave={vi.fn()} onTest={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByLabelText(/host/iu) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/port/iu) as HTMLInputElement).value).toBe('563');
  });
});
