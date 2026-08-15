# Task 1 report: Workspace scaffold and shared API types

Commit: `987943cc96c3fca7ef4cfb0c45441cd784781d1a` — "Add workspace scaffold and shared API types"
(local only, not pushed)

## What was built

An npm workspace root plus two packages (`@playarr/shared` with real source,
`@playarr/server` with manifest/tsconfig only — no `src/` yet), the shared DTO
module every later task imports, and its unit tests. `npm run check` is green.

## Files created

Root:
- `package.json`
- `tsconfig.base.json`
- `tsconfig.json`
- `vitest.config.ts`
- `.oxlintrc.json`
- `.prettierrc`
- `.gitignore`
- `package-lock.json` (from `npm install`)

`packages/shared/`:
- `package.json`
- `tsconfig.json`
- `src/index.ts`
- `test/covered-bytes.test.ts`

`packages/server/`:
- `package.json`
- `tsconfig.json`
(no `src/` — see deviation below)

Modified (side effect of `prettier --write .` run across the whole repo, see below):
- `README.md`
- `docs/superpowers/plans/2026-08-10-playarr-v1.md`
- `docs/superpowers/specs/2026-08-10-playarr-design.md`

## Commands run, with real output

### Version resolution check (before writing any files)

```
$ npm view typescript@7.0.2 version   → 7.0.2
$ npm view oxlint@1.77.0 version      → 1.77.0
$ npm view prettier@3.9.6 version     → 3.9.6
$ npm view vitest@4.1.10 version      → 4.1.10
$ npm view @types/node@26.1.2 version → 26.1.2
```

All five pinned versions in the brief resolve exactly on npm. No substitution
was needed for any package.

### Install

```
$ npm install
added 143 packages, and audited 146 packages in 10s
1 high severity vulnerability (in @fastify/static, see "Concerns" below)
```

Installed versions actually resolved (via `^` ranges):
- `typescript`: 7.0.2 (exact, as pinned)
- `vitest`: 4.1.10 (exact, as pinned)
- `prettier`: 3.9.6 (exact, as pinned)
- `oxlint`: 1.78.0 (patch above pin, satisfies `^1.77.0`, expected npm behavior — not a substitution)
- `@fastify/static`: 8.3.0 (satisfies `^8.1.1`)

### typecheck

```
$ npm run typecheck
> tsc -b
(no output, exit 0)
```

### lint

```
$ npm run lint
> oxlint --deny-warnings
(no output, exit 0)
```

Sanity-checked that oxlint's `typescript/no-explicit-any` rule actually fires:
temporarily appended `export const bad: any = 1;` to
`packages/shared/src/index.ts`, reran oxlint, got:

```
packages/shared/src/index.ts:142:19: error typescript(no-explicit-any): Unexpected `any`. Specify a different type.
```

then removed the line before proceeding. Confirms lint is not silently
passing because it isn't matching files.

### format:check → format → format:check

First run failed (expected per the brief, since docs/ pre-existing markdown
and the newly-written JSON files hadn't been through prettier yet):

```
$ npm run format:check
[warn] .superpowers/sdd/2026-08-10-playarr-v1/progress.md
[warn] .superpowers/sdd/2026-08-10-playarr-v1/task-1-brief.md
[warn] docs/superpowers/plans/2026-08-10-playarr-v1.md
[warn] docs/superpowers/specs/2026-08-10-playarr-design.md
[warn] package.json
[warn] packages/server/package.json
[warn] packages/shared/package.json
[warn] packages/shared/src/index.ts
[warn] README.md
Code style issues found in 9 files. Run Prettier with --write to fix.
(exit 1)
```

Per the brief's instruction ("If format:check fails, run npm run format once
and re-run npm run check"):

```
$ npm run format
(rewrote the 9 files listed above)
$ npm run check
> tsc -b                    (clean)
> oxlint --deny-warnings     (clean)
> prettier --check .         All matched files use Prettier code style!
> vitest run
 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  16:41:56
   Duration  99ms
```

`npm run check` is green: typecheck, lint, format:check, and all 7 tests pass.

## Deviations from the brief, and why

1. **Root `build` script**: brief has
   `"build": "tsc -b && npm run build --workspace @playarr/client"`.
   `@playarr/client` doesn't exist until Task 14. Changed to `"build": "tsc -b"`
   as instructed. Task 14 should restore the `@playarr/client` half.

2. **`packages/server` dropped from the root `tsconfig.json` references.**
   The brief's root `tsconfig.json` references both `packages/shared` and
   `packages/server`. `packages/server/tsconfig.json` includes
   `src/**/*.ts` and `test/**/*.ts`, but no `src/` exists yet in this task —
   confirmed this would make `tsc -b` fail with "no inputs were found" for that
   project if referenced. Per the resolved ambiguity ("prefer dropping the
   reference"), the root `tsconfig.json` here only references
   `packages/shared`:
   ```json
   { "files": [], "references": [{ "path": "packages/shared" }] }
   ```
   `packages/server/package.json` and `packages/server/tsconfig.json` were
   still created exactly as specified in the brief (Step 2 explicitly lists
   them as files to create) — they just aren't wired into the root build yet.
   Task 2, which creates `packages/server/src/coverage/coverage.ts`, should add
   `{ "path": "packages/server" }` back into the root `tsconfig.json`
   references array.

3. **Test file name**: the brief's "Files" list at the top names
   `packages/shared/test/types.test.ts`, but Step 4 gives the concrete file as
   `packages/shared/test/covered-bytes.test.ts` with that exact content. I
   created the file at the path Step 4 specifies (`covered-bytes.test.ts`),
   since that's where the literal, verbatim test content was given. No
   `types.test.ts` was created — there was no content specified for it, and
   creating an empty/duplicate file would contradict "no mock/placeholder
   files."

4. **`prettier --write .` reformatted pre-existing tracked files** outside the
   scope of this task's file list: `README.md` (added one blank line) and two
   docs files under `docs/superpowers/` (markdown table column realignment
   only — no textual/content changes, confirmed via `git diff`). This is an
   unavoidable side effect of running `prettier --write .` over the whole repo
   as the brief instructs when `format:check` fails. Included in the commit
   since `git add -A` was used and the changes are purely cosmetic
   whitespace/alignment, not content changes.

## Concerns for reviewers

- `npm audit` reports one high-severity advisory rollup for `@fastify/static`
  (moderate-severity path-traversal / route-guard-bypass issues in the
  `>=8.0.0 <=9.1.0` range, resolved here to 8.3.0). This dependency is pinned
  in the brief (`^8.1.1`) for `packages/server`, which has no code yet in this
  task, so it isn't exploitable yet — but whoever implements the static-file
  serving in a later task should either bump past 9.1.0 (if that satisfies the
  project's Fastify 5 compatibility) or add a mitigation before wiring up
  directory listing / static serving.
- `packages/server` currently has a `package.json` and `tsconfig.json` but no
  `src/`, and is not yet referenced from the root `tsconfig.json`. This is
  intentional per the resolved ambiguity, but it means `tsc -b` from the root
  right now only builds `@playarr/shared`. Task 2 must add the server
  reference back once `src/coverage/coverage.ts` exists, or `npm run
  typecheck` will continue to silently skip the server package.
- `oxlint` produces zero stdout output on a clean run (confirmed this is
  expected behavior, not a broken invocation, by injecting a deliberate `any`
  violation and observing it get caught, then reverting).
- Node engine in `package.json` is `>=22.0.0` but the environment's installed
  Node is v24.19.0; no compatibility issues observed.

## Fix round 1

The coordinator verified this task independently and found `npm run check`
does not actually pass in a clean checkout once `.superpowers/` contains this
report file, plus two related type-safety gaps. All three are fixed.

### Finding 1: `format:check` fails on `.superpowers/`

Root cause: prettier has no ignore file, so `prettier --check .` walks into
the git-ignored `.superpowers/` scratch directory and trips on this very
report file (a chicken-and-egg problem — my original "check green" run was
taken before the report existed).

Fix:
- Added root `.prettierignore`:
  ```
  node_modules
  dist
  dist-types
  *.tsbuildinfo
  packages/client/dist
  .superpowers
  docs/superpowers/
  ```
  `docs/superpowers/` is included per the coordinator's explicit instruction
  so those plan/spec files stay byte-stable while they're still being used as
  execution inputs, even though the fix-round-0 reformat of them is being left
  in place (no content was lost, per the coordinator — not reverting).
- Added `.superpowers/` to the root `.gitignore` (it was previously untracked
  only via a nested `.superpowers/sdd/.gitignore` with a bare `*` pattern;
  the root ignore is the belt-and-suspenders fix the coordinator asked for
  and covers the directory even if that nested file changes).

Verified by deliberately appending malformed content to a scratch file under
`.superpowers/sdd/2026-08-10-playarr-v1/` and confirming `prettier --check .`
still reported "All matched files use Prettier code style!" (then removed the
scratch file).

### Finding 2: test files were never typechecked

Root cause: `packages/shared/tsconfig.json` only has `"include":
["src/**/*.ts"]`, so `tsc -b` never opened `packages/shared/test/`.

Chose: **a root `tsconfig.test.json`** (the first option offered, matching
the `nzb-utils` pattern), not per-package `include` additions. Reasons:
- A per-package `include: [..., "test/**/*.ts"]` would fold test files into
  each package's `composite: true` project, which requires `declaration`/
  `declarationMap` emission consistent with `rootDir`; test files aren't part
  of the package's public build output and shouldn't get `.d.ts` files
  written into `dist/`. Keeping tests out of the composite build graph avoids
  that friction entirely.
- A single root project scales flatly as tasks add `packages/server/test/`
  and, later, `packages/client/test/` — the glob `packages/*/test/**/*.ts`
  picks up every package's tests with no per-package wiring, and root-level
  tooling files (`vitest.config.ts`) get a home too.

`tsconfig.test.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "noEmit": true
  },
  "include": ["vitest.config.ts", "packages/*/test/**/*.ts"]
}
```
`composite`/`declaration`/`declarationMap` are turned off because this
project only typechecks (`noEmit: true`) and is never referenced by another
project's `references` array, so composite's cross-project guarantees don't
apply. Files a test imports (e.g. `packages/shared/src/index.ts`) are pulled
into the program automatically via module resolution even though `src/**` is
outside this project's `include` glob — `include` only seeds root file names.

Root `package.json` `typecheck` script changed:
```
"typecheck": "tsc -b && tsc -p tsconfig.test.json"
```

Later tasks adding `packages/server/test/**/*.ts` or `packages/client/test/**/*.ts`
need no config changes — the glob already covers them.

### Finding 3: `vitest.config.ts` owned by no tsconfig

Fixed by the same `tsconfig.test.json`, which explicitly includes
`vitest.config.ts` in its root file list (see Finding 2). The editor's
"Cannot find module 'vitest'" error was the same root cause as Finding 2 —
no tsconfig had ever pulled `vitest.config.ts` (or any test file) into a
program, so no `node_modules/vitest` type resolution ever happened for that
file. No dedicated fix was needed beyond what Finding 2 already does.

### Verification: `npm run check` from a state with the report file present

```
$ ls .superpowers/sdd/2026-08-10-playarr-v1/
progress.md  task-1-brief.md  task-1-report.md

$ npm run check
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

 RUN  v4.1.10 /Users/chad/Projects/playarr/worktrees/initial-design

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  16:45:28
   Duration  96ms (transform 12ms, setup 0ms, import 17ms, tests 2ms, environment 0ms)
```

All four stages pass with the report file physically present in
`.superpowers/`, closing the gap the coordinator identified.

### Files touched in this round

- Modified: `.gitignore` (added `.superpowers/`)
- Modified: `package.json` (`typecheck` script now chains
  `tsc -p tsconfig.test.json`)
- Created: `.prettierignore`
- Created: `tsconfig.test.json`

### Note per coordinator's instruction — not acted on

The fix-round-0 `prettier --write .` reformat of `docs/superpowers/plans/2026-08-10-playarr-v1.md`
(184 lines) and `docs/superpowers/specs/2026-08-10-playarr-design.md` (48 lines)
is left in place as instructed — no content was lost and the plan's 17 task
headings are intact. `docs/superpowers/` is now in `.prettierignore` so it
won't drift further while still in use as an execution input.
