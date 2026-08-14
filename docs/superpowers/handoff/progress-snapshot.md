# SDD ledger — plan: docs/superpowers/plans/2026-08-10-playarr-v1.md

Branch: initial-design
Worktree: /Users/cwalker/Projects/playarr/worktrees/initial-design
Tasks: 17

Pre-flight: two plan defects found and fixed before Task 1 (commit pending):

- Task 1's DTO tests were tautological (asserting shapes of literals written in
  the test). Replaced with real tests for a new `coveredBytes` helper in
  @playarr/shared, which also removes the same sum being computed in three
  places (app.ts, Download, client).
- Task 8's ENOSPC test spied on `writeSegment`, a private method that has no
  such public name. Rewritten to spy on `download.fd.write` and to assert the
  failure is NOT recorded as a dead article.

Pre-flight fixes committed as bd8e51d. BASE for Task 1 = bd8e51d.

Task 1: fix round 1/5 (3 addressed, 0 open — npm run check failed on prettier
scanning .superpowers/; test files were outside every tsconfig so tsc never
checked them; root vitest.config.ts owned by no tsconfig; commits 987943c..d1c886c)
Task 1: complete (commits 987943c..d1c886c, review clean — spec compliant,
no Critical/Important)
Task 1: minor (deferred): commit bundles a whitespace-only prettier reformat of
the plan and spec docs, outside the task's file list. Content verified intact.
Task 1: minor (deferred): coveredBytes has no test for a negative run start
(the Math.max(0, start) clamp). Gap originates in the plan's own test content.
Task 1: carried forward — root tsconfig.json currently references only
packages/shared; packages/server was dropped because it had no src/ yet.
TASK 2 MUST RESTORE IT or typecheck silently skips the server forever.
Task 1: carried forward — root `build` script is `tsc -b` only; Task 14 must
restore the `npm run build --workspace @playarr/client` half.

Task 2: BASE d1c886c. Restored packages/server to root tsconfig references.
Task 2: fix round 1/5 (1 addressed, 0 open — server tsconfig had rootDir "."
and included test/**, so tsc emitted dist/test/*.test.js and put source at
dist/src/, which would have broken the Dockerfile CMD at Task 17 and shipped
tests to production. Now rootDir "src", tests excluded from the composite
build; commits 797410d..56655c9)
Task 2: controller-verified — dist contains only coverage/coverage.*, and a
deliberate type error in a server test does fail `npm run typecheck`.
Task 2: complete (commits 797410d..56655c9, review clean — spec compliant,
no Critical/Important). Reviewer ran oxlint against the brief's original
snippets: no-inline-comments and max-lines-per-function are real and enabled,
so the deviations from verbatim plan code were justified.
Task 2: minor (deferred): SegmentCoverage.addRun treats end === start as a
no-op BEFORE validating the bounds, so addRun(-1,-1) and addRun(1.5,1.5)
silently succeed instead of throwing. Plan-mandated; matters only if a later
task passes computed or untrusted bounds.

NOTE for all later server tasks: packages/server/tsconfig.json is now
rootDir "src", include ["src/**/*.ts"] only. Source goes in src/, tests in
test/ (typechecked by the root tsconfig.test.json, not the composite build).

Task 3: BASE 56655c9, first commit d52d22c (32/32 green, check clean).
Task 3: review found 3 Important, ALL plan-mandated (defects in my brief, not
the implementer's work). Escalated to Chad per process; he ruled on all three:
  1. Debounced write failure = unhandled rejection -> process death, and the
     update was silently dropped. RULING: retain-and-retry, re-arm the
     debounce, surface via an onError callback; an awaited flush() still
     rejects to its caller.
  2. "coalesces rapid updates into one write" asserted only final file
     contents, so three separate writes would pass. RULING: add a
     write-count assertion.
  3. Per-file oxlint override for max-classes-per-file. RULING (amended by
     Chad): cap the rule at 2 repo-wide — `"eslint/max-classes-per-file":
     ["error", 2]` — rather than disabling it. An error type belongs with the
     module that throws it, but the rule should still catch real sprawl.
     Verified oxlint's schema accepts the numeric option before instructing.
     STANDING POLICY for all later tasks: 2 classes per file (one primary
     plus its error). HttpError, FatalDownloadError, NotConfiguredError all
     land in later tasks under this budget.
Task 3: fix round 1/5 (4 addressed, 0 open — unhandled-rejection/lost-update,
untested coalescing, lint override, temp-file cleanup; commits d52d22c..2fd2bf8)
Task 3: complete (commits d52d22c..2fd2bf8, review clean)
Task 3: minor (deferred): state.test.ts beforeEach uses mockClear() which does
not drain queued mockImplementationOnce entries. Nothing leaks today; a later
test that errors before triggering its write could bleed a queued rejection
into the next test.

API CHANGE for later tasks: JobStateWriter's constructor is now
(dir, intervalMs?, onError?) — onError defaults to a no-op. A failed debounced
write retains its state, re-arms, and reports via onError; an awaited flush()
still rejects to its caller.

Task 4: BASE 2fd2bf8, first commit 85905f5 (44/44 green, check clean).
Task 4: JobStore constructor is now (root, now?, id?, onWriteError?) where
onWriteError is (jobId, error) => void, defaulting to a no-op. TASK 13 should
wire logging to it — a dropped coverage write is otherwise invisible.
Task 4: review approved. Reviewer verified the scan() decomposition preserved
all three branches, that the onWriteError test drives a real write failure
through the timer path (not a direct callback call), and that every cited lint
rule (unicorn/no-array-sort, require-await, no-inline-comments) is real and
enabled via `oxlint --print-config`.
Task 4: one Important, plan-mandated: outputPath() did join(record.dir, name)
with no containment check, and selection.name originates in attacker-supplied
NZB text. Controller-resolved the cross-task half: Task 10's resolveOutputName
DOES sanitize at write time via basename(), with traversal tests — confirmed in
the plan text. But outputPath() reads the name back out of state.json on the
user's volume, where parseJobState only checks it is a non-empty string.
Dispatched additive hardening (reject any name that is not its own basename,
throw rather than coerce) as fix round 1. Not escalated: the fix aligns with
the plan's intent rather than contradicting it.
Task 4: minor (deferred): synthetic corrupt-state record uses
nzbName: 'source.nzb' and epoch createdAt, so a failed record renders as
real-looking metadata. Fixing means changing a shared DTO; left for the final
review to triage.
Task 4: minor (deferred): module-scope vi.mock of node:fs/promises in
store.test.ts (passes through to real impl; matches state.test.ts convention).
Task 4: fix round 1/5 (1 addressed, 0 open — outputPath containment; commits
85905f5..219b71c). Re-reviewer probed node:path directly: all traversal vectors
blocked, and no legitimate name (spaces, unicode, .hidden.mp4, -rf, '...') is
wrongly rejected. A NUL byte passes outputPath and fails at the fs call — noted
as non-containment, not a gap.
Task 4: complete (commits 85905f5..219b71c, review clean)

Pre-flight for Task 5 (commit 6004a24): the plan's credentialsFor tests called
`(pass as { get(): Promise<string> }).get()`, but the installed
@chad3814/secret-provider defines `Provider<T> = () => Promise<T>` — a plain
callable with no .get(). Those tests could not have passed. Rewrote them to
narrow on typeof (NntpSecret = string | Provider<string>, so no cast is
needed) and added coverage for the username chain and for no-source-answers.
Confirmed signatures: chain(...providers), fromEnv(name), fromFile(path),
fromStatic(value), memoize(provider, isExpired?).

Task 5: BASE 6004a24, first commit fc4edc6 (70/70 green, check clean).
Task 5: implementer deviated from the brief: the library's fromEnv(name) always
reads the real process.env and ignores the env object threaded through
credentialsFor, so the brief's literal code failed 2 tests. Controller-verified
there is NO library injection path — even the two-arg fromEnv(read, label)
overload receives an Environment supplied by the library. A local
fromInjectedEnv helper (rejecting with a real ProviderError naming the
variable) is therefore justified, and keeps credentialsFor(stored, env)'s
signature honest instead of silently ignoring its own parameter.
Task 5: task review dispatched over 6004a24..fc4edc6. Named risks: whether
fromInjectedEnv's ProviderError preserves chain's fall-through/aggregation, and
whether the prefer-type-error lint fix altered any error contract.
Task 5: controller removed a stray empty out.txt left in the worktree by an
agent (untracked, 0 bytes).
Task 5: review confirmed the security properties hold (no eager reads, no
memoize, no password field — enforced by test AND by SettingsDto's type, 0600
on create and overwrite, ProviderError propagates untouched verified against
chain.ts's actual `instanceof ProviderError && !error.tryNextLink` logic).
Task 5: 3 Important, all plan-mandated. NOT escalated — every fix serves the
plan's stated intent rather than contradicting it, so no "which governs"
question exists. Dispatched as fix round 1:
  1. The ProviderError test asserted bare .rejects.toThrow(), so it would pass
     even if credentialsFor wrapped the error in a generic Error — destroying
     the diagnosability the test's own comment claims to protect. My test, my
     error.
  2. Two credentialsFor tests do a real readFile of /run/secret/nntp_password.
     They pass only because that path is absent on this machine, and would
     behave differently inside a container where the mount exists. Fix: an
     optional secretPaths param defaulting to the real constants, plus a new
     test for the secret-file-exists path (currently untested, and it is the
     path a Docker/K8s secret mount actually takes).
  3. resolveSettings used `??` for host/username, so an empty-string env var
     beats a valid stored value. NOT hypothetical: Task 17's docker-compose.yml
     sets `NNTP_HOST: ${NNTP_HOST:-}`, which injects '' when unset on the host.
     Default compose path = configure via settings page, restart, settings
     silently stop being used. port/connections escape this only because
     positiveInteger rejects Number('') === 0.
Task 5: TASK 17 NOTE — when writing docker-compose.yml, either keep the
`${VAR:-}` defaults (now safe once fix 3 lands) or drop the empty-string
defaults entirely. Do not reintroduce the assumption that an unset var arrives
as undefined; through compose it arrives as ''.
Task 5: fix round 1/5 (4 addressed, 0 open — weak ProviderError assertion, real
/run/secret reads in tests, empty-string env precedence, indistinguishable
unset-vs-empty message; commits fc4edc6..5107829)
Task 5: complete (commits fc4edc6..5107829, review clean)

Pre-flight for Task 6 (commit f12fb65). IMPORTANT LESSON — read
node_modules, NOT /Users/cwalker/Projects/nzb-utils, when checking @chad3814
APIs. The local nzb-utils worktree is AHEAD of the published 1.1.0 this project
installs: it has already renamed NntpConnectionFailure.at -> .attempt for a
future 2.0.0. A brief written from the local source would not compile.
Installed 1.1.0 facts: NntpConnectionFailure is `{ at: number; reason: string }`
(a plain record, not an Error), exported from the package index;
NntpPool.destroy() is synchronous void; NntpPool.failures is
readonly NntpConnectionFailure[]. Fixed in the plan: PoolLike.failures typed as
NntpConnectionFailure[] instead of unknown[] (which violated the no-unknown
constraint), the `as unknown as PoolLike` cast dropped (NntpPool satisfies
PoolLike structurally), failure messages read .reason, and the test fixture
uses { at, reason } instead of an Error.
Task 3: carried forward — tsconfig.base.json has global "types": ["node"].
TASK 14 must override "types" in packages/client, which is a browser package
and would otherwise inherit process/Buffer/global ambients.
