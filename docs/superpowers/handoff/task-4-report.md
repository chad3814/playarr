# Task 4 Report: JobStore

## What was built

`JobStore`, the class owning the on-disk layout of jobs. A job is a directory
containing `source.nzb` and `state.json`; `JobStore` creates that directory,
lists/looks up records held in memory, updates state through the existing
`JobStateWriter` debounce, removes the directory, and rebuilds its in-memory
index from disk on boot (`scan()`). It does not fetch articles and does not
know what a segment is — it only reads/writes files and delegates NZB parsing
to `@chad3814/nzb-parser` and state (de)serialization to `./state.ts`.

## Files created

- `packages/server/src/jobs/store.ts` — `JobStore` class, `JobRecord`
  interface, `NZB_FILENAME` constant.
- `packages/server/test/store.test.ts` — 8 tests across 8 top-level
  `describe` blocks.

No other files were modified.

## Deviations from the brief, and why

1. **`onError` wired through a fourth constructor parameter (per the
   coordinator's pre-resolved ambiguity #1).** `JobStore`'s constructor is now
   `(root, now?, id?, onWriteError?: (jobId: string, error: Error) => void = () => {})`.
   A private `#makeWriter(dir, id)` helper constructs every `JobStateWriter`
   as `new JobStateWriter(dir, undefined, (error) => this.#onWriteError(id, error))`,
   used from both `create()` and the boot-scan path, so the failing write's
   job id always travels with the error. `undefined` for `intervalMs` is
   deliberate: `JobStateWriter`'s parameter has a default value, so passing
   `undefined` explicitly keeps the writer's own 1s default rather than
   duplicating that constant here. Did not attempt to mark the job failed
   from inside the callback, per instruction — a new test
   (`JobStore.update - onWriteError`) verifies the callback fires with the
   correct job id and an `Error` instance, using the same fake-timer /
   mocked-`writeFile` pattern already established in `state.test.ts`.

2. **Fixture NZB used verbatim — no change needed.** Before trusting the
   brief's fixture, I ran it directly through `parseNzb` from
   `@chad3814/nzb-parser` (installed at `node_modules/@chad3814/nzb-parser`,
   version resolves to `^1.1.0`) in isolation. It parsed cleanly on the first
   try — one file, two segments, `subjectHints.name` resolved to
   `Some.Film.mp4`, `contiguous: true`. Also verified the deliberately broken
   `'<nzb><file>'` fixture from the second `create()` test throws
   `NzbParseError` (message: `<file> is missing the "poster" attribute`).
   So per resolution #2, no fixture edits were required and none were made.

3. **`store.ts` internals reorganized into private helper methods
   (`#scanEntry`, `#loadState`, `#makeWriter`)** rather than keeping `scan()`
   as one long loop body, to keep `scan()` itself under oxlint's
   `max-lines-per-function` limit. Behavior is unchanged from the brief's
   transcription — same corrupt-state handling, same
   `ready` → `paused` demotion on boot, same "ignore directories without a
   readable `source.nzb`" skip logic. The `continue; // comment` trailing
   comment from the brief was moved to its own line above the `return;` to
   satisfy `eslint(no-inline-comments)`.

4. **Test file split into 8 top-level `describe` blocks** instead of the
   brief's 3 (`JobStore.create`, `JobStore.scan` with 4 `it`s inside,
   `JobStore.remove`), per the `max-lines-per-function` guidance in the task
   instructions. `JobStore.scan` became four separate describes (`rebuilding
   from disk`, `corrupt state`, `resuming from a previous ready state`,
   `directories without a job`), each holding exactly one of the brief's
   original `it` blocks with every assertion intact. Added a ninth describe,
   `JobStore.update - onWriteError`, for the new test from resolution #1.

5. **Two lint fixes beyond the brief's literal code**, found only by running
   `oxlint --deny-warnings`:
   - `list()`: changed `.sort(...)` to `.toSorted(...)` — `unicorn(no-array-sort)`
     flagged the original brief code (`[...this.#records.values()].sort(...)`)
     because `.sort()` mutates in place even though it's operating on a fresh
     spread array; `.toSorted()` is the non-mutating equivalent and behaves
     identically here.
   - Test helper `scratch()`: brief declared it `async function scratch(): Promise<string> { return mkdtemp(...); }`.
     `eslint(require-await)` flagged the `async` keyword as needless since the
     function body has no `await` (it just returns the promise). Changed to
     a plain (non-async) function returning the promise directly — this
     matches the existing convention already used by `scratch()` in
     `packages/server/test/state.test.ts`.

No other deviations. `create()` still parses before touching disk (kept the
brief's ordering and its corresponding test asserting `store.list()` stays
empty after a rejected parse). `JobStateError`'s `code` union (`'corrupt' |
'missing'`) matches what's actually on disk in `state.ts`; `scan()`'s corrupt
branch doesn't switch on that code (it just distinguishes `JobStateError` from
any other thrown error for the message), so no drift there to reconcile.

## Commands run, with real output

### Parser sanity check (fixture verbatim, run once via a temp script, deleted after)

```
$ node packages/server/test-nzb-tmp.mjs
OK {
  "meta": [],
  "files": [ { "poster": "p@example.com", ... "subjectHints": { "name": "Some.Film.mp4", "part": 1, "totalParts": 2, "declaredSize": null }, "totalEncodedBytes": 2000, "contiguous": true } ],
  "groups": [ "alt.binaries.test" ]
}
```

```
$ node packages/server/test-nzb-tmp2.mjs
ERROR (expected): NzbParseError <file> is missing the "poster" attribute (at offset 5)
```

(Both temp scripts were deleted immediately after use; not part of the commit.)

### Test run, first pass

```
$ npx vitest run packages/server/test/store.test.ts
 RUN  v4.1.10 /Users/chad/Projects/playarr/worktrees/initial-design

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  09:08:04
   Duration  119ms (transform 24ms, setup 0ms, import 37ms, tests 14ms, environment 0ms)
```

### Full check, before lint fixes

```
$ npm run check
...
> npm run lint
> oxlint --deny-warnings

packages/server/src/jobs/store.ts:49:40: warning unicorn(no-array-sort): Use `Array#toSorted()` instead of `Array#sort()`. ...
packages/server/test/store.test.ts:26:16: warning eslint(require-await): Async function has no `await` expression. ...
```

### Full check, after fixes (final, clean)

```
$ npm run check

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

 RUN  v4.1.10 /Users/chad/Projects/playarr/worktrees/initial-design

 Test Files  4 passed (4)
      Tests  44 passed (44)
   Start at  09:08:26
   Duration  154ms (transform 84ms, setup 0ms, import 136ms, tests 34ms, environment 0ms)
```

44 tests total across 4 files (`state.test.ts`, `coverage.test.ts`,
`covered-bytes.test.ts`, and the new `store.test.ts` with 8 tests) — all
passing, nothing skipped.

## Anything a reviewer should know

- `JobStore` never calls `fs.*Sync`; all fs access goes through
  `node:fs/promises` (`mkdir`, `readdir`, `readFile`, `rm`, `writeFile`),
  consistent with the async-fs constraint.
- `remove()` disposes the writer (flushing any pending debounced write) before
  `rm`-ing the directory, so a pending coverage write can't race the removal
  and resurrect a `state.json` in a directory that's about to vanish — this
  is unchanged from the brief and preserved as-is.
- The new `onWriteError` test mocks `node:fs/promises`' `writeFile` (module
  mock, `vi.mock('node:fs/promises', ...)`, matching the exact pattern already
  used in `state.test.ts`) so it can inject exactly one rejected write via
  `mockImplementationOnce`, then uses fake timers to let `JobStateWriter`'s
  own timer-driven retry path fire the `onError` callback. It asserts both
  the job id (`'job1'`, via the deterministic `id` closure) and that the
  second callback argument is an `Error` instance.
- Did not add any handling that tries to persist a `failed` status from
  inside `onWriteError`, per the coordinator's explicit instruction — that is
  left for a later task (logging wiring).
- `packages/server/dist/**` was not touched; only source and test files were
  added.
- No secrets, no network calls in tests, no `any`/`unknown`-as-escape-hatch
  anywhere in the new code.

## Commit

```
git add packages/server/src/jobs/store.ts packages/server/test/store.test.ts
git commit -m "Add JobStore with boot scan and corrupt-state handling"
```

## Fix round 1

Review approved the task overall (scan decomposition confirmed
behavior-preserving, onWriteError test confirmed to drive a real write
failure through the timer path, cited lint rules confirmed real and
enabled). One Important finding was raised and addressed:

### Finding 1 (Important): `outputPath()` could escape the job directory

`outputPath()` did `join(record.dir, name)` with no containment check on
`selection.name`. `parseJobState` only validates that the field is a
non-empty string, and `state.json` lives on the user's volume, so a
hand-edited or corrupted state file could carry a name like
`../../etc/cron.d/x` and steer a write outside the job directory —
`outputPath()` is the single choke point every later task will use to open
the video file.

**Fix** (`packages/server/src/jobs/store.ts`): `outputPath()` now rejects any
`selection.name` that is not already its own basename. It throws a plain
`Error` naming the job id and the offending value (rather than silently
coercing to the basename) when the name is the empty string, `.`, `..`,
contains a backslash, or `basename(name) !== name`. The backslash check is
explicit and separate from the `basename()` comparison because
`node:path`'s `basename()` only treats `/` as a separator on POSIX (the
platform this app runs on) — it leaves a string like `..\..\windows\x`
untouched, so relying on `basename()` alone would have let a
backslash-based traversal slip through unflagged. Verified this directly:

```
$ node -e "const { basename } = require('node:path'); console.log(JSON.stringify(basename('a\\\\b')));"
"a\\b"
```

No change to the "no selection" behavior (still throws
`job <id> has no selected file`), and no change of contract for any
legitimately-derived name: the brief for a later task's `resolveOutputName`
helper already strips directory components via `basename()`, so
`basename(name) === name` already holds for every valid selection — this is
additive hardening at the read/choke-point only.

**Tests added** (`packages/server/test/store.test.ts`), plus a
`withSelection(store, id, name)` test helper that forces a record's
in-memory state to carry an arbitrary (possibly unsafe) selection without
going through the sanitizing write path, since the fix is specifically
about defending against a value that already made it into `state.json`:

- `JobStore.outputPath - valid selection`: returns the expected joined path
  for a normal name.
- `JobStore.outputPath - no selection`: throws `no selected file` when the
  job has never been given a selection (this test did not previously exist —
  the original brief had no `outputPath` tests at all, so it was added here
  rather than "kept").
- `JobStore.outputPath - unsafe selection names`: a `describe.each`-style
  table covering a name with a forward slash, a name with a backslash,
  `'..'`, and the empty string — each asserted to throw
  `/unsafe selection name/u`.

Left untouched, per the coordinator's explicit instruction (deferred
minors, not this task's problem): the synthetic corrupt-state record's
`nzbName: NZB_FILENAME` / epoch `createdAt`, and the module-scope
`vi.mock('node:fs/promises', …)` pattern.

### Full check, after the fix (final, clean)

```
$ npx vitest run packages/server/test/store.test.ts

 RUN  v4.1.10 /Users/chad/Projects/playarr/worktrees/initial-design

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  09:16:31
   Duration  135ms (transform 26ms, setup 0ms, import 39ms, tests 16ms, environment 0ms)

$ npm run check

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

 RUN  v4.1.10 /Users/chad/Projects/playarr/worktrees/initial-design

 Test Files  4 passed (4)
      Tests  50 passed (50)
   Start at  09:16:35
   Duration  138ms (transform 54ms, setup 0ms, import 108ms, tests 31ms, environment 0ms)
```

50 tests total (was 44; 6 new `outputPath` tests added), all passing,
nothing skipped.

### Commit

```
git add packages/server/src/jobs/store.ts packages/server/test/store.test.ts
git commit -m "Harden JobStore.outputPath against traversal in a corrupted state.json"
```
