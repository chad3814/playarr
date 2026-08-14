# Task 5 report: Settings store and credential resolution

## Fix round 1

Three findings, all against material I wrote in round 1 (test assertions and
`resolveSettings`/`credentialsFor` behavior), addressed as follows.

**Finding 1 — the `ProviderError` test asserted nothing about the error.**
`await expect(resolve(pass)).rejects.toThrow();` with no argument passes for
any thrown value, so it would not have caught `credentialsFor` starting to
wrap the chain's failure in a generic `Error`. Before changing anything, I
probed the real aggregated message with a throwaway script
(`chain(fromInjectedEnv({}, 'NNTP_PASSWORD'), fromFile('/tmp/does-not-exist'))`)
and got:

```
no provider resolved a value (NNTP_PASSWORD not set in the environment; /tmp/does-not-exist-playarr-secret does not exist)
```

So the aggregated message does name both the env var and the file path, as
expected. The test ("rejects when no source can supply a password...") now
catches the rejection explicitly and asserts `caught instanceof ProviderError`,
plus that the message contains `'NNTP_PASSWORD'` and the secret-mount path
used in that test.

**Finding 2 — two `credentialsFor` tests hit the real `/run/secret/*` path.**
`credentialsFor` gained an optional third parameter,
`secretPaths?: { user: string; pass: string }`, defaulting internally (via
`??`, not an object-literal default parameter — see lint note below) to
`SECRET_USERNAME_PATH`/`SECRET_PASSWORD_PATH`. Production call sites that omit
the third argument are unaffected. Tests that fall through the environment
link now pass a `tempSecretPaths()` helper (a fresh `mkdtemp` directory with
`nntp_username`/`nntp_password` filenames, neither created) instead of the
real absolute paths. Added a new test, "reads a mounted secret file ahead of
the stored password," which writes a file at the temp `pass` path and asserts
it is read and wins over `stored.password` — the previously-untested "secret
mount present" branch, which is the one Docker/Kubernetes secrets actually
exercise.

One consequence worth flagging: the "rejects when no source can supply a
password" test's message assertion now checks for the *temp* path rather than
the literal string `/run/secret/nntp_password`, since that test no longer
touches the real path (per this same finding). The underlying code path
(`fromFile` naming whatever path it was given, in the aggregated failure) is
identical; only the path value differs between test and production. Flagging
this because Finding 1's fix text specifically mentioned the real path — the
two findings pull in that direction together and I resolved the tension in
favor of Finding 2's isolation requirement, which is the stricter constraint
the task brief itself calls out ("no real filesystem outside a temp
directory").

**Finding 3 — an empty `NNTP_HOST`/`NNTP_USERNAME` overrides a valid stored
value.** `resolveSettings` used `env['NNTP_HOST'] ?? stored?.host ?? ''`, and
`??` does not treat `''` as absent. Added a local `envString()` helper that
maps an unset-or-blank (`.trim() === ''`) value to `undefined` so it falls
through to the stored value; applied it to both `host` and `username`
resolution. `port`/`connections`/`security` were already immune
(`positiveInteger` rejects `Number('')`, and `security` maps an unmatched
string, including `''`, back to the fallback), so those were left untouched.
Added two tests: `NNTP_HOST: ''` and `NNTP_USERNAME: ''`, each with `stored`
present, asserting the stored value survives.

**Minor — `fromInjectedEnv` message specificity.** Split the single
"absent-or-empty" branch into two, matching the library's own `fromEnv`
wording exactly: `'${name} not set in the environment'` for `undefined`,
`'${name} is set but empty'` for `''`. Both remain default-`tryNextLink`
(`true`) `ProviderError`s, and neither message includes the variable's value.

**Two additional lint fixes surfaced by these changes, not called out in the
findings but required for `npm run check` to pass:**
- `unicorn/no-object-as-default-parameter` on `credentialsFor`'s new third
  parameter — changed from an object-literal default to `secretPaths?: {...}`
  with `secretPaths?.user ?? SECRET_USERNAME_PATH` /
  `secretPaths?.pass ?? SECRET_PASSWORD_PATH` computed in the function body.
- `eslint(max-lines-per-function)` on the `resolveSettings` describe block
  once two new tests pushed it to 60 lines — split into
  `describe('resolveSettings', ...)` (the four original happy-path cases) and
  a new `describe('resolveSettings: malformed or blank environment values', ...)`
  holding the pre-existing `NNTP_CONNECTIONS: 'eight'` case plus the two new
  empty-string cases. No case, assertion, or `it` name was dropped or altered
  — the original block was split in place.

**Left untouched per the coordinator's explicit instruction:** the `chmod`
after `writeFile` in `ConfigStore.save`, the `Error` → `TypeError` change in
the test's `resolve()` helper (from round 1), and the `fileExists` export.

### Commands run (fix round 1)

```
$ npx vitest run packages/server/test/settings.test.ts
 Test Files  1 passed (1)
      Tests  23 passed (23)

$ npm run check
> tsc -b && tsc -p tsconfig.test.json          (passed)
> oxlint --deny-warnings                        (no output — passed)
> prettier --check .                            All matched files use Prettier code style!
> vitest run
 Test Files  5 passed (5)
      Tests  73 passed (73)
```

(70 tests before this round across all packages; 73 after — the settings
suite grew from 20 to 23: +2 `resolveSettings` empty-string cases, +1
`credentialsFor` mounted-secret case. The `ProviderError`/no-source rejection
test and the `NNTP_HOST`/`NNTP_USERNAME` empty-string tests are net-new
coverage requested by the findings; no existing case was removed.)

## What was built (fix round 1 predecessor — original submission)

- `packages/server/src/config/store.ts` — `ConfigStore` class: `load()` reads
  and JSON-parses `config.json`, returning `null` on any absence/read/parse
  failure (never throws at boot); `save()` writes to a `.tmp` sibling at mode
  `0600` and atomically `rename`s it into place, cleaning up the temp file if
  the rename fails.
- `packages/server/src/config/settings.ts` — `StoredConfig`,
  `ResolvedSettings`, `SECRET_PASSWORD_PATH` (`/run/secret/nntp_password`),
  `SECRET_USERNAME_PATH` (`/run/secret/nntp_username`), and:
  - `resolveSettings(stored, env)` — merges stored config with env overrides
    (`NNTP_HOST`/`PORT`/`SECURITY`/`CONNECTIONS`/`USERNAME`), env always wins,
    returns `null` when no host is configured anywhere, guards a non-numeric
    `NNTP_CONNECTIONS`/`NNTP_PORT` from becoming `NaN`.
  - `credentialsFor(stored, env)` — returns `{ user, pass }` as
    `NntpSecret` (`Provider<string>`), built with `chain(...)` from
    `@chad3814/secret-provider`, ordered env → secret-mount file → stored
    value. No credential is read eagerly; each is a thunk resolved only when
    `NntpPool`/`AUTHINFO` calls it. Not memoized here — `NntpPool` already
    memoizes what it's given.
  - `fileExists(path)` — real `access()`-based secret-mount check, the default
    for `describeSettings`'s injectable `secretExists` parameter.
  - `describeSettings(stored, env, secretExists = fileExists)` — returns
    `SettingsDto | null` with `hasPassword`/`passwordFromEnvironment` booleans
    and no `password` field, ever, by construction (the return object literal
    has no such key).
  - `mergeUpdate(stored, update)` — omitted password keeps the stored one;
    `''` clears it (spread-conditional omits the key entirely rather than
    storing `''` or `undefined`).
- `packages/server/test/settings.test.ts` — 20 unit tests (ConfigStore x3,
  resolveSettings x5, describeSettings x5, credentialsFor x4, mergeUpdate x3).
  No network, all filesystem access via `mkdtemp(tmpdir())`. Real
  `/run/secret/*` paths are never touched — `describeSettings` tests always
  pass an injected `secretExists`/`noSecrets`/`allSecrets` predicate.

## Deviation from the brief, and why

**`credentialsFor` does not call the package's `fromEnv` for its env-var
link.** I implemented the brief's `credentialsFor` verbatim first and ran the
test suite before making any changes, to confirm this wasn't a
misunderstanding on my part. Two tests failed:

```
FAIL credentialsFor > prefers the environment over the stored password
  Expected: "env-secret"  Received: "stored-secret"
FAIL credentialsFor > prefers the environment username over the stored one
  Expected: "env-user"    Received: "stored-user"
```

Root cause, confirmed by reading `node_modules/@chad3814/secret-provider/src/from-env.ts`:
both overloads of `fromEnv` resolve through a shared `readingEnv` helper that
calls `read(process.env)` — the *real* `process.env`, unconditionally. Neither
overload has any way to bind to a caller-supplied environment object. So
`fromEnv('NNTP_PASSWORD')` inside `credentialsFor(stored, env)` ignores the
`env` parameter entirely and reads the real process environment instead —
which is empty in the test process, so the chain fell through to the stored
value regardless of what the test passed as `env`.

Since `credentialsFor`'s own `env` parameter is required by the interface
(and is the whole point of "environment beats the volume" being testable
without mutating real `process.env`, matching how `resolveSettings` and
`describeSettings` already take `env` as a plain parameter), I added a small
local helper, `fromInjectedEnv(env, name)`, that mirrors `fromEnv`'s
fall-through semantics (absent-or-empty → `ProviderError`, otherwise resolve)
but reads the given `env` object instead of `process.env`. `chain`, `fromFile`,
`fromStatic`, and `ProviderError` are still used exactly as the brief
specifies; only the env-var link is a local equivalent. In production this is
called as `credentialsFor(stored, process.env)`, so behavior is identical to
using the package's `fromEnv` there — the difference only matters for
dependency-injected tests, which is exactly where it needed to differ.

I did not memoize `fromInjectedEnv`'s output and did not read env eagerly;
it's a thunk like every other link in the chain.

**Test-file lint fixes (behavior unchanged).** The brief's verbatim test file,
run through `oxlint --deny-warnings`, produced six warnings that fail the
build under `--deny-warnings` (pedantic-category rules are warnings, not
off): `require-await` (`async () => false`, `async () => true` with no
`await` inside), `consistent-function-scoping` (`resolve` nested inside a
`describe` block that doesn't use its outer scope), and `prefer-type-error`
(throwing `Error` after a `typeof` check). Fixed by:
- `noSecrets`/`allSecrets`: `(): Promise<boolean> => Promise.resolve(false/true)`
  instead of `async () => false/true`.
- Moved the `resolve` helper (and its comment) from inside
  `describe('credentialsFor', ...)` to module scope, next to the `stored`
  fixture — it's a `TypeError`, not `Error`, thrown when a test's assumption
  ("this is a provider function") is violated.
- Replaced the inline `async () => true` argument in the "counts a mounted
  secret file..." test with the module-level `allSecrets`.

No test name, assertion, or case was changed or removed — same 20 cases,
same expectations, same coverage.

**Implementation lint fixes (behavior unchanged):**
- `settings.ts`: `fromInjectedEnv`'s returned function used `async () => {...}`
  with no `await` inside (`require-await`); rewritten to a plain arrow
  returning `Promise.resolve(value)` / `Promise.reject(new ProviderError(...))`.
- `store.ts`: `unlink(temp).catch(() => undefined)` triggered
  `unicorn/no-useless-undefined`; changed to `.catch(() => {})`, same no-op
  semantics.

## Design notes for the reviewer

- **`ConfigStore.load()` casts `decoded as StoredConfig` without field-by-field
  validation.** This was flagged as deliberate in the task instructions — a
  trust boundary for a file only the local user (or `ConfigStore.save()`
  itself) ever writes. I kept it as specified and left the same comment
  explaining the reasoning in the source (`store.ts`, in `load()`), so a
  reviewer sees it was a considered choice, not an oversight.
- **`describeSettings` never resolves a credential.** It only checks: is
  `NNTP_PASSWORD` a non-empty string in `env`, does the secret-mount file
  exist per the injected `secretExists`, and is `stored.password` a non-empty
  string. It never calls `credentialsFor` or resolves any provider, so no
  password value is ever read into memory for the purpose of describing
  settings.
- **`credentialsFor` never runs a provider itself** — it only builds and
  returns the `chain(...)` thunks. The tests exercise resolution by calling
  the returned provider directly (`secret()`), matching how `AUTHINFO PASS`
  would call it downstream.
- **No password string appears in `settings.ts`, `store.ts`, or their tests
  outside the `'stored-secret'`/`'env-secret'`/`'replacement'` test fixtures.**
  The two tests in `describeSettings` that assert `JSON.stringify(dto)` and
  `Object.keys(dto!)` never contain `'stored-secret'`/`'password'` pass.
- Test count is 20, not the 19 the brief predicted (`ConfigStore` 3 +
  `resolveSettings` 5 + `describeSettings` 5 + `credentialsFor` 4 +
  `mergeUpdate` 3 = 20); this is just an arithmetic note in the brief, not a
  functional discrepancy — every case in the brief's test file is present.

## Files created

- `packages/server/src/config/store.ts`
- `packages/server/src/config/settings.ts`
- `packages/server/test/settings.test.ts`

No existing file was modified. `src/coverage/coverage.ts`, `src/jobs/state.ts`,
and `src/jobs/store.ts` were not touched.

## Commands run

```
$ npx vitest run packages/server/test/settings.test.ts   # before store.ts/settings.ts existed
FAIL  cannot resolve '../src/config/store.ts'
Test Files  1 failed (1)

# after writing store.ts + settings.ts verbatim per brief
$ npx vitest run packages/server/test/settings.test.ts
FAIL credentialsFor > prefers the environment over the stored password
FAIL credentialsFor > prefers the environment username over the stored one
Test Files  1 failed (1)
     Tests  2 failed | 18 passed (20)

# after switching credentialsFor's env-var link to fromInjectedEnv
$ npx vitest run packages/server/test/settings.test.ts
Test Files  1 passed (1)
     Tests  20 passed (20)

$ npm run check
> tsc -b && tsc -p tsconfig.test.json          (no output — passed)
> oxlint --deny-warnings
packages/server/src/config/settings.ts:77:10: warning eslint(require-await) ...
packages/server/src/config/store.ts:50:38: warning unicorn(no-useless-undefined) ...
packages/server/test/settings.test.ts:24:19: warning eslint(require-await) ...
packages/server/test/settings.test.ts:123:80: warning eslint(require-await) ...
packages/server/test/settings.test.ts:138:12: warning unicorn(consistent-function-scoping) ...
packages/server/test/settings.test.ts:140:17: warning unicorn(prefer-type-error) ...

# after the lint fixes described above
$ npm run check
> tsc -b && tsc -p tsconfig.test.json          (passed)
> oxlint --deny-warnings                        (no output — passed)
> prettier --check .                            All matched files use Prettier code style!
> vitest run
 Test Files  5 passed (5)
      Tests  70 passed (70)
```

Full 70-test suite (all packages) passes; 20 of those are the new
`settings.test.ts`.

## Concerns for later tasks

- Task 6 (settings HTTP routes / connection test) will need to call
  `resolveSettings`/`credentialsFor`/`describeSettings`/`mergeUpdate` and
  `ConfigStore` together — none of that wiring exists yet, by design (out of
  scope for this task).
- `ConfigStore`'s untrusted-cast `load()` behavior means a hand-edited
  `config.json` with wrong field types (e.g. `port` as a string) will pass
  `load()` silently and only surface downstream in `resolveSettings`'s
  `positiveInteger`/`security` guards for the fields those guards cover, or
  possibly propagate an untyped value for fields that have no such guard
  (`host`, `username`, `connections` as a non-number would satisfy TypeScript
  at compile time but not at runtime). This is consistent with the "deliberate
  narrowing" the brief calls for; flagging it for whoever writes the settings
  route in case additional runtime guards feel warranted there.
