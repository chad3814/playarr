# playarr — resume here

Handoff written 2026-08-14 to move this work to another machine. Read this
file top to bottom before touching anything.

## What this project is

playarr streams an MP4 out of a Usenet NZB to a browser **while it is still
downloading**, runs locally in Docker, and afterwards lets you keep the file or
delete it. It is built on Chad's own `@chad3814` Usenet toolkit
(`nzb-parser`, `nntp`, `nzb`), all installed from npm at `^1.1.0`.

- **Spec (approved):** `docs/superpowers/specs/2026-08-10-playarr-design.md`
- **Plan (17 tasks):** `docs/superpowers/plans/2026-08-10-playarr-v1.md`

Read the spec's first two sections before any implementation work. Two
decisions drive everything else:

1. **Playback starts immediately and is allowed to stall.** Usenet throughput
   is often below video bitrate, so the server serves bytes as it has them and
   the HTTP response simply becomes slow. There is no readiness estimator and
   no pre-buffer gate — backpressure does the work.
2. **A seek re-anchors the fetcher, so the file has holes.** That is why
   segment coverage is persisted state, and why "download this afterwards" has
   a hole-filling step in front of it.

## Where things stand

- **Branch:** `initial-design` (pushed to `origin/initial-design`)
- **Tasks complete:** 5 of 17 — through Task 5 (settings + credentials)
- **Tests:** 73 passing, `npm run check` green
- **Nothing is in flight.** Task 5's review loop closed cleanly. Task 6 has
  had its plan corrections committed but has **not** been dispatched.

Commit history, newest first:

| Commit | What |
| --- | --- |
| `f12fb65` | Task 6 plan corrections (installed nntp types) |
| `5107829` | Task 5 fix round 1 |
| `fc4edc6` | Task 5 settings store + credential chain |
| `6004a24` | Task 5 plan correction (real `Provider` shape) |
| `219b71c` | Task 4 fix round 1 (`outputPath` traversal) |
| `85905f5` | Task 4 JobStore |
| `2fd2bf8` | Task 3 fix round 1 |
| `d52d22c` | Task 3 job state persistence |
| `56655c9` | Task 2 fix round 1 (build layout) |
| `797410d` | Task 2 SegmentCoverage |
| `d1c886c` | Task 1 fix round 1 |
| `987943c` | Task 1 workspace scaffold |
| `bd8e51d` | Pre-flight plan fixes |
| `f96df7c` | The plan |
| `50a536b` | The spec |

## Setting up on the new machine

This project uses the **bare-repo + worktrees** layout, so there is no working
tree at the project root. Detect it with:

```sh
git --git-dir="$(git rev-parse --git-common-dir)" rev-parse --is-bare-repository
```

If the repo is not cloned yet, use the `project-setup` skill against
`git@github.com:chad3814/playarr.git`, then create a worktree for
`initial-design` with the `add-worktree` skill. All work happens inside
`worktrees/initial-design/`.

Then:

```sh
npm install
npm run check     # expect: typecheck + lint + format:check clean, 73 tests pass
```

If `npm run check` is not green before you start, stop and fix that first —
every task gate depends on it.

## The process being followed

`superpowers:subagent-driven-development`, controller-driven:

1. `scripts/task-brief PLAN_FILE N` → dispatch one implementer subagent with
   the brief path, the report path, and only the cross-task context the brief
   cannot know. Never paste accumulated history into a dispatch.
2. Record BASE (`git rev-parse HEAD`) **before** dispatching.
3. On DONE: independently verify `npm run check`, then
   `scripts/review-package PLAN_FILE BASE HEAD` → dispatch a task reviewer.
4. Findings → fix round (resume the same implementer for rounds 1–3) → scoped
   re-review over the fix diff only.
5. Append to the ledger, mark the todo complete, move to the next task.

Scripts live in
`$HOME/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts/`.

**The ledger is the recovery map:** `.superpowers/sdd/2026-08-10-playarr-v1/progress.md`.
That directory is **gitignored**, so a copy travels beside this file as
`progress-snapshot.md`, along with each completed task's implementer report.
On the new machine, recreate the live ledger by copying the snapshot back:

```sh
mkdir -p .superpowers/sdd/2026-08-10-playarr-v1
cp docs/superpowers/handoff/progress-snapshot.md \
   .superpowers/sdd/2026-08-10-playarr-v1/progress.md
cp docs/superpowers/handoff/task-*-report.md \
   .superpowers/sdd/2026-08-10-playarr-v1/
```

Task briefs and review diffs were not copied — both regenerate from the plan
and from git.

## Standing decisions established so far

These are **not** in the plan. They were decided during execution and bind
every remaining task.

- **`max-classes-per-file` is capped at 2 repo-wide** (`.oxlintrc.json`), not
  disabled. One primary class plus its error type. Chad ruled on this
  explicitly. `HttpError`, `FatalDownloadError`, and `NotConfiguredError` all
  land in later tasks under this budget.
- **`JobStateWriter(dir, intervalMs?, onError?)`** — a failed debounced write
  retains its state, re-arms its own retry, and reports through `onError`
  (default no-op). An explicitly awaited `flush()` still rejects to its caller.
- **`JobStore(root, now?, id?, onWriteError?)`** where `onWriteError` is
  `(jobId, error) => void`, default no-op.
- **`credentialsFor(stored, env, secretPaths?)`** — the third parameter exists
  so tests never read the real `/run/secret/` paths. It defaults per-field to
  the real constants.
- **Test files are typechecked** by a root `tsconfig.test.json`
  (`npm run typecheck` = `tsc -b && tsc -p tsconfig.test.json`). Test globs
  must **not** be added back to any package tsconfig.
- **`packages/server/tsconfig.json` is `rootDir: "src"`, `include: ["src/**/*.ts"]`.**
  Source in `src/`, tests in `test/`. This matters: with `rootDir: "."` the
  build emitted `dist/src/…` and shipped test files, which would have broken
  the Dockerfile's `CMD` at Task 17.
- **`tsconfig.base.json` sets `"types": ["node"]` globally.**

## Hard-won lessons — do not relearn these

1. **Verify library APIs against `node_modules`, never against
   `/Users/chad/Projects/nzb-utils`.** That local worktree is *ahead* of the
   published 1.1.0 this project installs — it has already renamed
   `NntpConnectionFailure.at` → `.attempt` for a future 2.0.0. A brief written
   from the local source will not compile. (On the new machine `nzb-utils` may
   not exist at all, which conveniently forces the right habit.)
2. **`Provider<T>` from `@chad3814/secret-provider` is `() => Promise<T>`** — a
   plain callable, *not* an object with `.get()`. The plan originally called
   `.get()` and could not have worked.
3. **`fromEnv(name)` always reads the real `process.env`** and ignores any
   injected env object. Even the two-arg `fromEnv(read, label)` overload gets
   its `Environment` from the library. There is no injection path, which is why
   `settings.ts` has a local `fromInjectedEnv` helper that rejects with a real
   `ProviderError` so `chain`'s fall-through still works.
4. **`chain` only continues past a link when the error is
   `instanceof ProviderError && !error.tryNextLink`.** A hand-rolled provider
   throwing a plain `Error` would turn a missing source into a hard failure.
5. **Through docker-compose, an unset variable arrives as `''`, not
   `undefined`** (`NNTP_HOST: ${NNTP_HOST:-}`). Never use `??` alone to let an
   env var override stored config — `''` is not nullish and will silently blank
   a saved setting.
6. **Lint rules that repeatedly bite:** `eslint(no-inline-comments)` (comments
   on their own line, never trailing code), `eslint(max-lines-per-function)`
   (split long `describe` blocks into several top-level ones, keeping every
   case and assertion), `unicorn/no-array-sort` (use `toSorted`),
   `unicorn/no-object-as-default-parameter`, `require-await`,
   `no-useless-undefined`, `consistent-function-scoping`, `prefer-type-error`.
   Front-load these into every dispatch; they have cost several rounds.
7. **Prettier scans everything not ignored.** `.prettierignore` covers
   `.superpowers` and `docs/superpowers/` for a reason — an agent's own report
   file will otherwise fail `format:check`.
8. **A subagent's "check is green" claim can predate its own report file.**
   Always re-run `npm run check` yourself before dispatching a reviewer.

## Obligations carried into specific future tasks

- **Task 13** (settings routes + entrypoint): wire logging to `JobStore`'s
  `onWriteError`. A dropped coverage write is otherwise invisible.
- **Task 14** (client scaffold): `packages/client` **must** override
  `"types"` in its tsconfig. It is a browser package and would otherwise
  inherit `process`/`Buffer`/`global` from the global `"types": ["node"]`.
  Also restore the root `build` script's
  `npm run build --workspace @playarr/client` half — it is currently just
  `tsc -b`.
- **Task 17** (Docker/compose): the Dockerfile `CMD` is
  `node packages/server/dist/index.js` — verify that path exists after
  `npm run build` rather than assuming. Do not reintroduce the assumption that
  an unset compose variable arrives as `undefined` (see lesson 5).

## Deferred minor findings, for the final whole-branch review

Point the final reviewer at this list so it can triage what must be fixed
before merge.

- Task 1: the scaffold commit bundles a whitespace-only prettier reformat of
  the plan and spec docs. Content verified intact.
- Task 1: `coveredBytes` has no test for a negative run start (the
  `Math.max(0, start)` clamp).
- Task 2: `SegmentCoverage.addRun` treats `end === start` as a no-op *before*
  validating bounds, so `addRun(-1, -1)` and `addRun(1.5, 1.5)` silently
  succeed instead of throwing. Matters if a caller ever passes computed
  bounds — **Task 8's `Download` does exactly that**, so check it there.
- Task 3: `state.test.ts`'s `beforeEach` uses `mockClear()`, which does not
  drain queued `mockImplementationOnce` entries. Nothing leaks today.
- Task 4: the synthetic corrupt-state record uses `nzbName: 'source.nzb'` and
  an epoch `createdAt`, so a failed job renders as real-looking metadata.
  Fixing it means changing a shared DTO.
- Task 4/5: module-scope `vi.mock('node:fs/promises', …)` in two test files.
  Both pass through to the real implementation.
- Task 5: narrow TOCTOU window in `ConfigStore.save` — `writeFile`'s `mode`
  applies only at creation, so a pre-existing temp file would briefly hold the
  plaintext password under its old permissions before the explicit `chmod`.
  Accepted risk for a local single-user service; worth a comment.

## Do this next

Task 6 (`PoolManager`) is ready to dispatch. Its plan text was already
corrected against the installed nntp types in `f12fb65` — trust the plan as it
now stands.

```sh
SDD="$HOME/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts"
"$SDD/task-brief" docs/superpowers/plans/2026-08-10-playarr-v1.md 6
git rev-parse HEAD    # this is BASE for the review package
```

Then dispatch one implementer per the process above. Task 6 is small and
fully specified — a mid tier model is enough. Its whole point is that the pool
factory is injected, so **every test must run without a socket**.

After Task 6, Task 7 ports `packages/nzb/test/post.ts` out of the `nzb-utils`
repo. **That is the one place the local `nzb-utils` checkout is genuinely
needed** — if it is not present on the new machine, the file can be recovered
from `github.com/chad3814/nzb-utils` at the tag matching the installed 1.1.0.
Do not hand-write a yEnc encoder instead; the fixture's value is that its CRCs
come from `node:zlib`, so a fixture cannot agree with a broken decoder by
construction.

Task 8 (`Download`) is the riskiest task in the plan and the heart of the
app. Budget accordingly, and hold its tests to asserting **article counts** —
"a backwards seek costs nothing" and "a seek inside the prefetch window does
not re-anchor" must be checkable facts, not prose.

## Standing rules from Chad, in force throughout

- **Never commit without explicit approval. Never push without explicit
  approval.** (This handoff commit and push were explicitly requested.)
- Never use the `any` type; never use `unknown` as a way around typing
  something.
- 2-space indent, semicolons always.
- A change is not done until lint, typecheck, tests, and build all pass.
- Every new feature ships with unit tests.
- Prefer async APIs over their sync twins.
- Commits are SSH-signed via 1Password's agent, which prompts for approval
  roughly every 15 minutes.
