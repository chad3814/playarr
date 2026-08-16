# playarr — known work

Everything here was found during the v1 build and deliberately deferred rather
than missed. Each item says what is wrong, why it was left, and what it costs to
leave it. Nothing here blocks running the app.

Grouped by the decision you would have to make, not by file.

## Design decisions

These are trade-offs, not bugs. They need a judgement rather than a fix.

- **The notifier records _parked_, not _interested_.** A reader woken by segment
  `k` is transiently absent from `SegmentNotifier` while it awaits `fd.read`
  before parking on `k + 1`, and the fetcher's decision point at
  `fetcher.ts:199-208` contains no `await`, so it provably falls inside that
  gap. Any instantaneous membership check therefore reads a live reader as
  departed — which is why the demand policy protects a rotation for a whole
  dwell rather than releasing it when the anchor leaves `segments()`. Two
  attempts at the instantaneous check were measured and both restored thrash
  (42 articles → 56). The real fix is for the notifier to distinguish an
  _aborted_ waiter from a _satisfied_ one, so the decision rests on information
  rather than inference. Cost of leaving it: a rotation can outlive the demand
  that justified it by up to one dwell. Bounded, self-clearing, no starvation.

- **`DEMAND_DWELL_SEGMENTS = 16`** (`download/demand.ts`) is a first estimate,
  not a measured optimum. A rotation abandons `prefetch + 1` articles and buys
  `dwell` segments, so waste sits just under a quarter during contention, at a
  cost of up to ~12 MiB of stall for the reader waiting its turn. Worth tuning
  against real playback.

- **`prime()` costs four articles, not one.** `prefetch()` starts `depth`
  fetches before the first yield, so priming pays for the head, the tail, and
  `prefetch + 1` abandoned articles — roughly 3 MiB on 750 KiB segments, on the
  first frame of every playback. Slicing the head pass to one segment would
  halve it; `#pass` already takes a bounded window, so it is a matter of letting
  the anchor carry a length. The current cost is pinned by a test, so a change
  here will show up as a failing count rather than silently.

- **`GET /stream` activates the job on every request**, including a bare full-body
  GET with no `Range` header, which anchors the fetcher at 0. Same family of
  question as the demand policy: who is allowed to move the anchor.

- **Server and client each derive candidate files independently**
  (`jobs/candidates.ts` and `views/Library.tsx`). Same algorithm, same
  `namesUnresolved` rule, written twice. `@playarr/shared` exists for exactly
  this. If they drift, the browser offers a file the server then refuses with a 415.

## Correctness

Real, reachable, none of them data-destroying.

- **`SegmentFetcher.#kick` assigns `this.#loop = this.#run(anchor)` with no
  `.catch`,** and `#run` has a `finally` but no `catch`. Anything thrown outside
  `#pass`'s try — `nextHoleExcluding` in the loop head, say — drops `#running`
  to false without running `rejectAll`, leaving every parked waiter hanging with
  no fetcher to wake it. The demand policy leans harder on the loop being the
  thing that eventually serves the notifier, which makes this worth a guard.

- **`upload.toBuffer()` sits outside the `try`** in `routes/jobs.ts`, so an
  upload over the 64 MiB multipart limit throws `RequestFileTooLargeError`
  (which carries `statusCode: 413`) to the generic handler, which ignores it and
  returns 500. A genuine client error reported as a server fault.

- **`JobStore` keys records by directory name while `state.id` comes from the
  file.** If they disagree — a hand-edited `state.json` — the DTO reports
  `state.id`, the client requests that id, and gets a 404 for a job it can see
  in the list.

- **`bytesPerSecond` never decays** (`download/rate.ts`). When the fetcher
  stalls, which the spec says is the normal case, the readout freezes at the
  last EMA and keeps claiming throughput. Separately, `if (seconds <= 0) return`
  discards every article landing in the same millisecond as its predecessor,
  which with ordered prefetch delivery is most of them — so the figure
  under-reports as well as failing to decay.

- **`#select`'s re-selection guard does not verify the output file still
  exists.** If `state.json` survives but the media file was removed by hand,
  re-select returns 200 and the subsequent `activate()` fails opening `'r+'`.
  Not reachable through the app's own delete, which removes the whole directory.

- **`abandonCompletion` writes `paused` while the `Download` may still be the
  manager's active one**, so `toJobDto` can briefly report
  `status: 'paused', active: true`. Cosmetic; `#releaseAll` already produces the
  same pairing transiently.

- **`#fillHoles` is a boolean, not a counter.** Safe with today's single caller,
  but two concurrent `completeAll()` calls on one `Download` would need a depth
  count.

## Security and operations

- **The container runs as root.** `node:22-slim` ships a `node` user; the
  runtime stage never drops to it, and `/data` is written as root. Worth
  `USER node` plus a matching `chown` for a container whose primary input is
  attacker-supplied XML.

- **Environment variables bypass the schema's bounds.** `NNTP_PORT` accepts
  99999 from the environment while the PUT schema caps it at 65535, and
  `NNTP_CONNECTIONS` is unbounded where the schema caps it at 100. `connections`
  drives `prefetch`, so an unbounded value means an unbounded number of decoded
  4 MiB articles held in memory.

- **A provider needing no authentication cannot be configured.** When the stored
  username is empty and neither `NNTP_USERNAME` nor the secret file exists, the
  credential chain has no source that can answer and rejects. Appending
  `fromStatic('')` for an explicitly blank username would close it.

- **`.dockerignore` does not exclude `.superpowers/`.** Harmless — it is
  discarded before the runtime stage — but it is build-context weight.

## Tests and CI

- **There is no CI.** "The smoke script never runs in CI" is currently true by
  absence rather than by configuration.

- **`vitest.config.ts` sets no `testTimeout`,** leaving the 5000 ms default. A
  40-run sweep during the build caught three unrelated tests doing real
  filesystem work under `vi.waitFor` timing out _simultaneously_ at ~8.3 s under
  load. CI machines are slower and more contended, so the first CI run will look
  like a flaky suite. Set `testTimeout: 15000` before wiring one up.

- **Several suites leak temp directories.** `app-fixture.ts`, `jobs-routes.test.ts`
  and `settings.test.ts` create `mkdtemp` directories and never remove them;
  `download-harness.ts` does it correctly and is the model.

- **Coverage gaps worth closing**, none load-bearing: `coveredBytes` has no test
  for a negative run start; `JobManager`'s wiring of `onObserverError` is
  untested (the guard itself is covered); the pure-timer double-take branch of
  the durability guard is unpinned; `store.test.ts` has a module-scope
  `vi.mock` of `node:fs/promises` that passes through to the real
  implementation.

- **Two assertions are weaker than they read.** The `FailingStore` test asserts
  `statusCode` is _not_ 400 rather than _is_ 500. The SSE teardown test proves
  `clearInterval` was called and that nothing ticked within one turn, where the
  version it replaced proved the ticker had actually stopped.

- **Two tests are timing-shaped and worth watching.** `shutdown-durability`'s
  failing direction depends on a microtask hop ordering a stray write after
  `flush()` resolves — deterministic today, but hop-counted. And the
  supersession test's `vi.waitFor` nudges the fake clock by its 50 ms poll
  interval while an independent 1000 ms fake timer is armed; both default to
  1000 ms, so a real `unlink` taking ~1 s of wall time would fire it early. It
  would fail loudly rather than pass vacuously.

## Comments and docs

- **`GatedArticleSource.fail()`'s docstring says "Every request for this
  Message-ID rejects."** It only affects requests made _after_ the call; a
  Message-ID already parked by `hold()` + `body()` still settles through the real
  source on `release()`. The behaviour is fine, the sentence is not, and it will
  mislead the next test author.

- **`observers.ts` says each observer call is "immediately followed by" the
  notify/rejectAll.** `#reportDrained()` intervenes between `covered()` and
  `notify()`. The substantive claim holds; the word does not.

- **`delivery.ts` has an orphaned docstring** — the "Serve the finished file"
  comment now sits above `contentDisposition`, leaving `downloadJob` undocumented
  — and exports `PROGRESS_INTERVAL_MS`, which nothing imports.

- **`filename*` under-encodes.** `encodeURIComponent` leaves `'`, `(`, `)`, `*`
  and `!` unescaped, and `'` is the RFC 5987 ext-value delimiter, so a filename
  containing an apostrophe produces a technically malformed parameter. Control
  characters and `"` are stripped, so there is no header injection and no 500;
  browsers fall back to the quoted form.

- **Three answers to one question.** The default connection count is 4 in
  `config/settings.ts`, 8 in the settings dialog's initial field value, and 8 in
  `docker-compose.yml`. It belongs in `@playarr/shared`.

## Structural

- **Two files have no headroom.** `jobs/manager.ts` is at 299 lines and
  `download/fetcher.ts` at 296, against a 300-line `max-lines` cap enforced by
  `oxlint --deny-warnings`. The next one-line change to either fails the lint
  gate and forces a split under time pressure — which is exactly the sequence
  `jobs/state.ts` went through before it was split deliberately. The seams:
  `#select`/`#install`/`#abandon` away from `#activate`/`#releaseAll` in the
  manager, and pass mechanics away from the loop in the fetcher.

- **The client's test tsconfig duplicates five settings** from its build
  tsconfig, because it cannot extend it — the test config needs
  `composite: false` / `noEmit: true` and the build config needs the opposite.
  Nothing links them, so extending `lib` in one silently leaves the other behind.

- **The root test tsconfig's `include` is an explicit per-package list** rather
  than a `packages/*/test` glob. A future package's tests would be typechecked
  by nothing at all — no error, no coverage — unless someone remembers to add
  it. Nothing in lint or tooling guards this.
