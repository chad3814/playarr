import { useCallback, useState, type FormEvent, type JSX } from 'react';
import type {
  NntpSecurity,
  SettingsDto,
  SettingsTestResult,
  SettingsUpdate,
} from '@playarr/shared';

interface Props {
  readonly settings: SettingsDto | null;
  readonly onSave: (update: SettingsUpdate) => Promise<SettingsDto>;
  readonly onTest: () => Promise<SettingsTestResult>;
  readonly onClose: () => void;
}

const SECURITIES: readonly NntpSecurity[] = ['implicit', 'starttls', 'none'];

interface FieldState {
  readonly host: string;
  readonly setHost: (value: string) => void;
  readonly port: string;
  readonly setPort: (value: string) => void;
  readonly security: NntpSecurity;
  readonly setSecurity: (value: NntpSecurity) => void;
  readonly connections: string;
  readonly setConnections: (value: string) => void;
  readonly username: string;
  readonly setUsername: (value: string) => void;
  readonly password: string;
  readonly setPassword: (value: string) => void;
}

/** Owns every form field's local state, seeded from the stored settings (if any). */
function useFields(settings: SettingsDto | null): FieldState {
  const [host, setHost] = useState(settings?.host ?? '');
  const [port, setPort] = useState(String(settings?.port ?? 563));
  const [security, setSecurity] = useState<NntpSecurity>(settings?.security ?? 'implicit');
  const [connections, setConnections] = useState(String(settings?.connections ?? 8));
  const [username, setUsername] = useState(settings?.username ?? '');
  // Never prefilled: the server does not return it and this form must not
  // invent a value that would overwrite what is stored.
  const [password, setPassword] = useState('');
  return {
    host,
    setHost,
    port,
    setPort,
    security,
    setSecurity,
    connections,
    setConnections,
    username,
    setUsername,
    password,
    setPassword,
  };
}

/** Blank password means "leave the stored one alone", never "blank it". */
function toUpdate(fields: FieldState): SettingsUpdate {
  return {
    host: fields.host,
    port: Number(fields.port),
    security: fields.security,
    connections: Number(fields.connections),
    username: fields.username,
    ...(fields.password === '' ? {} : { password: fields.password }),
  };
}

function IdentityFields({ fields }: { readonly fields: FieldState }): JSX.Element {
  return (
    <>
      <label>
        Host
        <input
          value={fields.host}
          onChange={(event) => fields.setHost(event.target.value)}
          required
        />
      </label>
      <label>
        Port
        <input
          type="number"
          value={fields.port}
          onChange={(event) => fields.setPort(event.target.value)}
          required
        />
      </label>
      <label>
        Security
        <select
          value={fields.security}
          onChange={(event) => fields.setSecurity(event.target.value as NntpSecurity)}
        >
          {SECURITIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label>
        Connections
        <input
          type="number"
          value={fields.connections}
          onChange={(event) => fields.setConnections(event.target.value)}
          required
        />
      </label>
    </>
  );
}

function CredentialFields({ fields }: { readonly fields: FieldState }): JSX.Element {
  return (
    <>
      <label>
        Username
        <input
          value={fields.username}
          onChange={(event) => fields.setUsername(event.target.value)}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={fields.password}
          onChange={(event) => fields.setPassword(event.target.value)}
          autoComplete="new-password"
        />
      </label>
    </>
  );
}

function PasswordNotice({
  settings,
}: {
  readonly settings: SettingsDto | null;
}): JSX.Element | null {
  if (settings?.passwordFromEnvironment === true) {
    return (
      <p className="notice">
        The password comes from the environment or a mounted secret. Nothing is stored on the
        volume, and anything typed here is ignored while that is set.
      </p>
    );
  }
  if (settings?.hasPassword === true) {
    return <p className="notice">A password is already stored. Leave this blank to keep it.</p>;
  }
  return null;
}

/**
 * The pool shrinks its own limit on a refusal, so the real connection cap is
 * only visible here, in the per-attempt failures a test surfaces.
 */
function TestResultView({
  result,
}: {
  readonly result: SettingsTestResult | null;
}): JSX.Element | null {
  if (result === null) {
    return null;
  }
  return (
    <>
      <p className={result.ok ? 'notice' : 'error'}>{result.message}</p>
      {result.failures.length > 0 && (
        <ul className="notice">
          {result.failures.map((failure, index) => (
            <li key={`${index}-${failure}`}>{failure}</li>
          ))}
        </ul>
      )}
    </>
  );
}

interface ActionsState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly result: SettingsTestResult | null;
  readonly submit: (event: FormEvent) => void;
  readonly test: () => void;
}

/** Owns saving and testing the connection, and the busy/error/result state both produce. */
function useActions(
  fields: FieldState,
  onSave: Props['onSave'],
  onTest: Props['onTest'],
  onClose: () => void,
): ActionsState {
  const [result, setResult] = useState<SettingsTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      void onSave(toUpdate(fields)).then(
        () => {
          setBusy(false);
          onClose();
        },
        (saveError: unknown) => {
          setBusy(false);
          setError(saveError instanceof Error ? saveError.message : String(saveError));
        },
      );
    },
    [fields, onSave, onClose],
  );

  const test = useCallback(() => {
    void onTest().then(setResult, (testError: unknown) =>
      setResult({ ok: false, message: String(testError), failures: [] }),
    );
  }, [onTest]);

  return { busy, error, result, submit, test };
}

export function SettingsDialog({ settings, onSave, onTest, onClose }: Props): JSX.Element {
  const fields = useFields(settings);
  const { busy, error, result, submit, test } = useActions(fields, onSave, onTest, onClose);

  return (
    <div role="dialog" aria-label="Provider settings" className="dialog">
      <form onSubmit={submit}>
        <IdentityFields fields={fields} />
        <CredentialFields fields={fields} />
        <PasswordNotice settings={settings} />

        {error !== null && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <TestResultView result={result} />

        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={test}>
          Test connection
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </form>
    </div>
  );
}
