# Task 3 report: Job state persistence

## Summary

Implemented `packages/server/src/jobs/state.ts` and its test suite
`packages/server/test/state.test.ts` per the brief, verbatim except for a
handful of lint-driven micro-edits and one test-ordering fix needed to make
the debounce test deterministic. All 32 repo tests pass, and `npm run check`
(typecheck, lint, format:check, test) is clean.

## Files created

- `packages/server/src/jobs/state.ts` — `JobState`, `JobSelection`,
  `JobGeometry`, `JobStateError`, `parseJobState`, `readJobState`,
  `writeJobState`, `JobStateWriter`. Content matches the brief's Step 3
  verbatim except for two lint fixes (see Deviations).
- `packages/server/test/state.test.ts` — the brief's 12 test cases, split
  across six top-level `describe` blocks (`parseJobState - valid input`,
  `parseJobState - rejects invalid input`, `writeJobState`, `readJobState`,
  `JobStateWriter - coalescing`, `JobStateWriter - flush and dispose`)
  instead of one, to satisfy oxlint's `max-lines-per-function` on the
  `describe` callback. Every test case and assertion from the brief is
  present unchanged, aside from the one line noted in Deviations.

## Files modified

- `tsconfig.base.json` — added `"types": ["node"]` to `compilerOptions`.
  This is the first module in the repo (src or test) to import a `node:*`
  builtin. Without this, `tsc -b` failed to resolve `node:fs/promises`,
  `node:path`, and the `NodeJS` namespace even though `@types/node` is
  installed at the workspace root — TypeScript 7 (`typescript@^7.0.2`, the
  native/Go port) did not auto-include it for this project the way earlier
  `tsc` versions do. This affects every package via the shared base config,
  which is correct: any future module that touches Node builtins needs the
  same types.
- `.oxlintrc.json` — added a scoped `overrides` entry disabling
  `eslint/max-classes-per-file` for `packages/server/src/jobs/state.ts` only.
  That file legitimately declares two classes: `JobStateError` (a ~10-line
  error type used at the parse trust boundary) and `JobStateWriter` (the
  debounced writer). Splitting the error class into its own file would
  separate it from the ~40-line validator that throws it, for no benefit.
  The override is file-scoped, not global, so the rule still applies
  everywhere else in the codebase.

## Deviations from the brief and why

1. **`JobStateWriter.flush()` is no longer declared `async`.** The brief's
   `flush()` body never uses `await` — both branches `return` a `Promise<void>`
   directly (either the existing `#inFlight` or a freshly chained one). oxlint's
   `eslint(require-await)` flagged this as a warning, and `npm run lint` runs
   with `--deny-warnings`. Removing `async` is behavior-preserving: the method
   still returns `Promise<void>`, TypeScript accepts it without wrapping, and
   all call sites (`await writer.flush()`) are unaffected.

2. **`unlink(temp).catch(() => undefined)` → `unlink(temp).catch(() => {})`.**
   oxlint's `unicorn(no-useless-undefined)` flagged the explicit `undefined`
   literal. Same behavior (swallow the unlink error), no explicit `undefined`.

3. **Test file: `async function scratch()` → `function scratch()`.** Same
   `require-await` issue — the body just returns `mkdtemp(...)`, a
   `Promise<string>`, without ever `await`ing. Removing `async` is
   behavior-preserving.

4. **Test file: `toThrow(/status/)` → `toThrow(/status/u)`.** oxlint's
   `eslint(require-unicode-regexp)` requires the `u` flag on regex literals.
   No behavior change for this pattern.

5. **Test file: added one line to the "coalesces rapid updates into one
   write" test — `await writer.flush();` right after
   `await vi.advanceTimersByTimeAsync(1_000);` and before reading the file.**
   This was necessary, not stylistic — see "Investigation: fake-timer race"
   below. Without it the test failed deterministically (not flaky — 100% of
   runs), because `vi.advanceTimersByTimeAsync` grants only one extra real
   event-loop turn per fake timer fired, but `writeJobState` requires two
   sequential real fs completions (`writeFile` then `rename`). The fake-timer
   tick resolved after the `writeFile` landed but before the `rename`, so
   `readFile(join(dir, 'state.json'))` hit `ENOENT`. Calling `writer.flush()`
   again after the tick is a no-op with respect to what gets written (no new
   `schedule()` call happened, so `#pending` is already `null` and no
   additional write is queued) — it simply awaits the writer's own
   `#inFlight` promise for real, which lets Node's actual event loop finish
   the pending write outside the fake clock's step-limited flushing. This
   preserves the test's intent (verify the three rapid `schedule()` calls
   coalesce into exactly one write, with the last value winning) while making
   the assertion deterministic.

6. **Split the single `describe('JobStateWriter', ...)` block from the brief
   into two: `'JobStateWriter - coalescing'` and
   `'JobStateWriter - flush and dispose'`**, and split the top-level
   `describe('parseJobState', ...)` into `'parseJobState - valid input'` and
   `'parseJobState - rejects invalid input'`, per the task instructions
   about `max-lines-per-function`. No test case or assertion was dropped;
   only grouping changed, following the precedent already established in
   `packages/server/test/coverage.test.ts` (`describe('SegmentCoverage - ...
   ')`).

None of these changes alter the validator's logic, the atomic-write
mechanism, or the debounce/coalesce semantics described in the brief.

## Investigation notes: fake-timer / real-fs interaction (for reviewers)

This is worth flagging explicitly since it wasn't one of the ambiguities
pre-resolved in the task instructions, and it could resurface in later tasks
that combine `vi.useFakeTimers()` with multi-step `fs.promises` chains.

Vitest 4's fake timer engine (`tickAsync`, used by
`advanceTimersByTimeAsync`) fires a timer callback, then yields exactly one
real macrotask turn (`originalSetTimeout(nextPromiseTick)`) before resolving,
per timer that fires in range. That single yield is enough for *one* pending
real async I/O completion to land, but `writeJobState`'s temp-file-then-rename
sequence is two sequential real fs completions chained by `await`. I
confirmed this with a minimal repro (a `JobStateWriter` with one `schedule()`
call, one `advanceTimersByTimeAsync`, then an immediate `readdir`): it
reliably showed `state.json.tmp` present but not yet renamed to `state.json`.
The fix — awaiting the writer's own `flush()`/`#inFlight` promise after the
tick, rather than reading the filesystem directly — sidesteps the fake
clock's step budget entirely by returning to a plain (non-tick-driven) await,
where the real event loop is free to run to completion. Verified stable
across 5 consecutive full-suite runs and 5 consecutive isolated runs of
`state.test.ts` with no failures.

## Commands run (verbatim output)

### `npx vitest run packages/server/test/state.test.ts` (final, after fixes)

```
 RUN  v4.1.10 /Users/cwalker/Projects/playarr/worktrees/initial-design


 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  17:04:40
   Duration  132ms (transform 18ms, setup 0ms, import 26ms, tests 12ms, environment 0ms)
```

Repeated 5x consecutively with identical "12 passed (12)" each time.

### `npm run check`

```
> playarr@0.0.0 check
> npm run typecheck && npm run lint && npm run format:check && npm run test


> playarr@0.0.0 typecheck
> tsc -b && tsc -p tsconfig.test.json


> playarr@0.0.0 lint
> oxlint --deny-warnings


> playarr@0.0.0 format:check
> prettier --check .

Checking formatting...
All matched files use Prettier code style!

> playarr@0.0.0 test
> vitest run


 RUN  v4.1.10 /Users/cwalker/Projects/playarr/worktrees/initial-design


 Test Files  3 passed (3)
      Tests  32 passed (32)
   Start at  17:08:24
   Duration  130ms (transform 55ms, setup 0ms, import 78ms, tests 14ms, environment 0ms)
```

Repeated `npm run test` 5x consecutively afterward with identical
"32 passed (32)" each time — no flakiness observed.

### Lint failures encountered and fixed along the way (for the record)

Before the fixes in "Deviations", `npm run lint` reported:

```
packages/server/src/jobs/state.ts:182:8: warning eslint(max-classes-per-file): File has too many classes (2). Maximum allowed is 1
packages/server/src/jobs/state.ts:170:36: warning unicorn(no-useless-undefined): Do not use useless `undefined`.
packages/server/src/jobs/state.ts:206:9: warning eslint(require-await): Async function has no `await` expression.
packages/server/test/state.test.ts:29:16: warning eslint(require-await): Async function has no `await` expression.
packages/server/test/state.test.ts:69:46: warning eslint(require-unicode-regexp): Use the 'u' flag.
```

### Typecheck failure encountered and fixed (for the record)

Before adding `"types": ["node"]` to `tsconfig.base.json`, `npm run typecheck`
reported:

```
packages/server/src/jobs/state.ts(1,53): error TS2591: Cannot find name 'node:fs/promises'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.
packages/server/src/jobs/state.ts(2,22): error TS2591: Cannot find name 'node:path'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.
packages/server/src/jobs/state.ts(186,11): error TS2503: Cannot find namespace 'NodeJS'.
packages/server/src/jobs/state.ts(199,19): error TS2304: Cannot find name 'setTimeout'.
packages/server/src/jobs/state.ts(208,7): error TS2304: Cannot find name 'clearTimeout'.
```

`@types/node@26.2.0` was already present in the workspace root
`node_modules`; it just wasn't being picked up automatically by
`typescript@7.0.2` for this project. Adding it explicitly to the shared base
config is the correct fix since this constraint applies to every package.

## Anything a reviewer should know

- `no-explicit-any` and `no-inline-comments` were not an issue here — the
  validator narrows `unknown` without ever using `any`, and all comments in
  both files are on their own line.
- The `.oxlintrc.json` override is intentionally scoped to
  `packages/server/src/jobs/state.ts` only, not a blanket rule change, so
  `max-classes-per-file` still guards every other file.
- The `tsconfig.base.json` change (`"types": ["node"]`) is global but
  additive and necessary — any later task that imports a `node:*` builtin
  would have hit the identical error.
- No network calls in tests; all state.test.ts tests use `mkdtemp(tmpdir())`
  scratch directories, matching the existing `coverage.test.ts` conventions.
- Followed the async-fs constraint throughout: `readFile`, `writeFile`,
  `rename`, `unlink`, `mkdtemp`, `readdir` are all from `node:fs/promises` /
  used via their promise forms, no `*Sync` calls.

---

## Fix round 1

Three findings from review, all originating in the brief. Addressed all
three plus the amendment to Finding 3.

### Finding 1 — retain and retry a failed debounced write

**Problem confirmed:** the brief's timer callback did `void this.flush()`
with no `.catch()`. A rejected `writeJobState` (ENOSPC, EACCES, ...) became
an unhandled rejection at that tick (Node terminates by default), and
`flush()` cleared `#pending` before attempting the write, so the update was
gone with no way for any caller to learn about it — directly contradicting
the class's own doc comment.

**Fix, in `packages/server/src/jobs/state.ts`:**

- Split the timer path from the explicit path. `schedule()` now calls a
  private `#arm()` (extracted from the old inline `setTimeout`) instead of
  going through `flush()`. The timer callback calls a new private
  `#flushFromTimer()`, not `flush()`.
- `#flushFromTimer()` builds the write chain with a trailing `.catch()`:
  on failure it (a) resurrects the failed `state` into `#pending` **only
  if** `#pending` is still `null` — i.e., only if nothing newer was
  scheduled while the write was in flight, so a fresher `schedule()` always
  wins over a resurrected stale one; (b) calls `#arm()` again so the retry
  happens on its own on the next interval, without anyone calling `flush()`;
  and (c) calls the new `#onError` callback with a real `Error` (coerced via
  a small `asError()` helper, since the `catch` binding is `unknown`, not
  `any`). Because this `.catch()` never rethrows, the promise assigned back
  to `#inFlight` always resolves — this failure can never surface as an
  unhandled rejection.
- `flush()` (the public, explicitly-awaited method) is unchanged in spirit:
  it still just chains `writeJobState` onto `#inFlight` and returns that
  promise, so a caller who does `await writer.flush()` still sees the
  rejection directly — no retry, no swallowing. The only change there is
  prefixing the chain with `.catch(() => {})` on the *previous* `#inFlight`,
  so that one explicit `flush()` failure doesn't permanently wedge every
  later write behind a rejected promise (`.then()` on an already-rejected
  promise skips the callback and just re-rejects with the old reason — that
  would otherwise make the writer permanently unusable after the first
  explicit failure).
- Constructor gained a third parameter:
  `onError: (error: Error) => void = () => {}`, stored as `#onError`,
  defaulting to a no-op as required.
- `dispose()` is unchanged — it still just `await`s `flush()`, so a failed
  final flush during shutdown still propagates to the caller, consistent
  with "only the timer-driven path is caught."

**Also fixed while in here (the brief's "minor" cleanup item):**
`writeJobState` previously only `unlink`ed the temp file when `rename`
failed; if the initial `writeFile` to the temp path failed partway, no
cleanup ran. Moved `writeFile` inside the same `try` as `rename` so either
failure now triggers the same `unlink(temp).catch(() => {})` cleanup.

**Tests added**, all in `packages/server/test/state.test.ts`, all passing
and reproducing the exact scenarios required:

- `'JobStateWriter - explicit flush surfaces its own failure'` — schedules a
  state, makes `writeFile` reject once, asserts `await writer.flush()`
  rejects with that error, then proves the writer is still usable afterward
  (schedules again, flushes, reads back the new value) — this is what
  demonstrates the `.catch(() => {})` guard actually prevents permanent
  jamming.
- `'JobStateWriter - retries a failed timer-driven write'` — schedules a
  state, makes the first `writeFile` call reject, advances the fake timer,
  and asserts `onError` was called once with an `Error`; then advances the
  timer again (no `flush()` call from the test) and asserts the retried
  write landed and the final `state.json` has the scheduled status. If the
  timer-path rejection were ever left unhandled, this test (and likely the
  whole run) would fail via Vitest's unhandled-rejection detection — so this
  test doubles as the "does not produce an unhandled rejection" check the
  finding asked for.
- `'JobStateWriter - supersession of a failed retry'` — uses a manually
  controlled `Promise` (captures `reject` into an outer `let rejectWrite`)
  so the first write can be left genuinely in flight. After the timer fires
  and starts that pending write, the test calls `schedule()` with a newer
  state *before* rejecting the first write. This exercises the exact race
  the finding described (`if (this.#pending === null)` check in
  `#flushFromTimer`'s catch handler) rather than just re-scheduling after
  the fact, which would have passed even with a buggy "always resurrect"
  implementation. Asserts the final file holds the newer state and
  `onError` was still called exactly once for the failed attempt.
- `'JobStateWriter - onError defaults'` — same failure/retry shape with no
  third constructor argument, proving the default no-op doesn't throw.

All four new tests were run 8x consecutively in isolation with no failures
(see Commands below), in addition to being part of the 5x full-suite reruns.

### Finding 2 — coalescing test now asserts write count, not just bytes

`packages/server/test/state.test.ts` now has, at module scope:

```ts
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
```

I chose the `vi.mock` route (the brief's first suggested option), not the
"count through an injected seam" route — Finding 1's fix does not introduce
a write seam; `writeJobState` still calls the real `node:fs/promises`
`writeFile`/`rename` directly, and adding a seam purely to count calls would
have been a seam added only for the test, which the finding said not to do.
The mock wraps the *real* `writeFile` (via `vi.fn(actual.writeFile)`) rather
than replacing it, so every other test in the file still performs real
filesystem writes — the mock only adds observability (`.mock.calls`) and,
where a test opts in with `mockImplementationOnce`, controlled failure
injection for Finding 1's tests. A top-level `beforeEach` calls
`vi.mocked(writeFile).mockClear()` so call counts don't leak between tests.

The "coalesces rapid updates into one write" test now asserts
`expect(vi.mocked(writeFile).mock.calls.length).toBe(1)` in addition to the
existing content assertion, so a writer that did three sequential writes
converging on the same bytes would now correctly fail this test.

### Finding 3 (amended) — `max-classes-per-file` capped at 2, not disabled

The original message asked to disable the rule repo-wide; a follow-up
amendment (received before I'd committed the disable) superseded that:
Chad wants it capped at 2, not turned off, so it still catches genuine
sprawl while allowing exactly the one legitimate pattern (a primary class
plus its error type). Implemented the amendment, not the original ask.

`.oxlintrc.json` now reads:

```json
{
  "categories": { "correctness": "error", "suspicious": "warn", "pedantic": "warn" },
  "rules": {
    "typescript/no-explicit-any": "error",
    "eslint/max-classes-per-file": ["error", 2]
  },
  "ignorePatterns": ["dist", "node_modules", "packages/client/dist"]
}
```

The `overrides` block I'd added for Finding 3's original ask is gone. The
numeric-severity-plus-integer form (`["error", 2]`) was accepted by oxlint
on the first try — no need to fall back to the object form
`["error", { "max": 2 }]`.

**Proof requested by the coordinator, both parts:**

1. `npm run check` passes with `state.ts` holding its two real classes
   (`JobStateError`, `JobStateWriter`) — see the full `npm run check` output
   under "Commands run" below; `oxlint --deny-warnings` is silent.
2. The rule fires at three. I temporarily appended a trivial third class to
   the end of `state.ts`:

   ```ts
   class ZzTemporaryThirdClass {}
   ```

   and ran `oxlint --deny-warnings` directly (redirected to a file so the
   exit code wasn't lost to a pipe through `tail`, which was my first,
   mistaken attempt — that showed `EXIT: 0` because it was `tail`'s exit
   code, not oxlint's). With output captured properly:

   ```
   $ npx oxlint --deny-warnings > /tmp/oxlint_output.txt 2>&1
   $ echo "EXIT: $?"
   EXIT: 1
   $ cat /tmp/oxlint_output.txt
   packages/server/src/jobs/state.ts:267:1: error eslint(max-classes-per-file): File has too many classes (3). Maximum allowed is 2 help: Reduce the number of classes in this file
   packages/server/src/jobs/state.ts:267:7: error eslint(no-unused-vars): Class 'ZzTemporaryThirdClass' is declared but never used. help: Consider removing this declaration.
   packages/server/src/jobs/state.ts:267:1: warning typescript(no-extraneous-class): Unexpected empty class. help: Delete this class
   ```

   Exit code 1, rule fires as `error` at count 3, message correctly reports
   "Maximum allowed is 2." I then removed the temporary class and reran
   `oxlint --deny-warnings`, which exited 0 again with no output. The cap is
   real, not a no-op.

**Note for later tasks:** this is now standing repo-wide policy — two
classes per file, meant for "one primary class plus its error type." Tasks
adding `HttpError`, `FatalDownloadError`, and `NotConfiguredError` should
each define them in the same module as the class that throws them, and stay
at exactly 2 classes in that file. A third class of any kind in the same
file will fail lint under this config, by design.

### Not changed

Per explicit instruction, `tsconfig.base.json`'s `"types": ["node"]`
addition from fix round 0 was left untouched.

### Commands run (verbatim output) — fix round 1

`npx vitest run packages/server/test/state.test.ts` — 16 tests now (12
original + 4 new for Finding 1):

```
 RUN  v4.1.10 /Users/cwalker/Projects/playarr/worktrees/initial-design


 Test Files  1 passed (1)
      Tests  16 passed (16)
   Start at  08:57:12
   Duration  122ms (transform 22ms, setup 0ms, import 31ms, tests 10ms, environment 0ms)
```

Repeated 8x consecutively, "16 passed (16)" every time, no unhandled
rejection warnings (`grep -i "unhandled\|reject\|warn\|error"` on the output
matched nothing).

Two lint warnings surfaced mid-work and were fixed before the final check:

```
packages/server/test/state.test.ts:190:66: warning eslint(max-lines-per-function): The function has too many lines (53). Maximum allowed is 50.
packages/server/test/state.test.ts:219:9: warning unicorn(consistent-function-scoping): Function `rejectWrite` does not capture any variables from its parent scope
```

Fixed by splitting the two-`it` describe block
(`'JobStateWriter - retries a failed timer-driven write'`) into two
separate `describe` blocks (one per `it`), and by hoisting the `rejectWrite`
placeholder's initial value to a module-scope `function noop(): void {}`
instead of a fresh `() => {}` recreated inside the test.

Final `npm run check`:

```
> playarr@0.0.0 check
> npm run typecheck && npm run lint && npm run format:check && npm run test


> playarr@0.0.0 typecheck
> tsc -b && tsc -p tsconfig.test.json


> playarr@0.0.0 lint
> oxlint --deny-warnings


> playarr@0.0.0 format:check
> prettier --check .

Checking formatting...
All matched files use Prettier code style!

> playarr@0.0.0 test
> vitest run


 RUN  v4.1.10 /Users/cwalker/Projects/playarr/worktrees/initial-design


 Test Files  3 passed (3)
      Tests  36 passed (36)
   Start at  08:58:17
   Duration  116ms (transform 35ms, setup 0ms, import 60ms, tests 15ms, environment 0ms)
```

Reran `npm run test` 5x consecutively afterward: "36 passed (36)" every
time, no flakiness.

### Files touched in this round

- `packages/server/src/jobs/state.ts` — retry/supersede/re-arm/`onError`
  logic in `JobStateWriter`; `writeJobState` cleanup now covers the
  `writeFile` failure path too; added `asError()` helper.
- `packages/server/test/state.test.ts` — added the `vi.mock('node:fs/promises', ...)`
  spy, the write-count assertion, four new tests for Finding 1, a
  `beforeEach` to clear the mock, and a module-scope `noop()` helper.
- `.oxlintrc.json` — replaced the file-scoped `overrides` block with a
  repo-wide `"eslint/max-classes-per-file": ["error", 2]` rule.
- `tsconfig.base.json` — untouched, as instructed.
