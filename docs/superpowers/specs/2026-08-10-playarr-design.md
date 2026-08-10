# playarr — design

**Status:** approved 2026-08-10. Scope is v1.

Stream video out of Usenet to a browser, locally, in Docker. Drop an NZB, pick an
MP4, watch it while it downloads, then keep the file or throw it away.

Built on the `@chad3814` Usenet toolkit (all at 1.1.0 on npm):
`nzb-parser` for the document, `nntp` for transport, `nzb` for `File`-like access
to a file inside the NZB. `par2` and `yenc` are not used in v1.

## What v1 is

Upload an NZB → list the MP4s it describes → play one → download or delete it.

Deliberately out of scope, each a clean follow-up: PAR2 repair, subtitles, disk
quota and auto-cleanup, MKV, transcoding, indexer search, authentication,
multi-user.

**MP4 only.** A browser `<video>` plays MP4 natively over byte ranges, which is
the entire mechanism this app depends on. MKV would mean either ffmpeg in the
image and a transcode pipeline, or a client-side demuxer with patchy codec
support. Non-MP4 files in an NZB are listed but not selectable, so it is visible
that the document parsed and simply has nothing playable.

**One active job at a time.** Several NZBs may sit on disk; exactly one fetches
articles. Starting playback of another pauses the first. The whole connection
pool serves whatever you are watching, which is also the fastest it can go, and
v1 needs no scheduling or fairness logic.

## The two decisions everything else follows from

### Playback starts immediately and is allowed to stall

Usenet throughput is frequently below video bitrate — the toolkit's own measured
figure is about 1 MiB/s against a 3.4 MB/s 2160p file. Rather than estimate
whether a file can play through, the server serves bytes as it has them and the
HTTP response simply becomes slow. The `<video>` element buffer-underruns and
spins on its own. There is no readiness estimator, no pre-buffer gate, and no
underrun logic to write: backpressure does the work.

### A seek re-anchors the fetcher, so the file has holes

When the player asks for a range that is not on disk, the fetcher abandons where
it was and starts fetching from the seek point forward. Whatever was already
downloaded stays. This makes seeking feel like a normal player, and it means the
file on disk is not contiguous — which is why coverage is persisted state, and
why "download this afterwards" has a hole-filling step in front of it.

## Shape

One container, one port. Fastify serves the JSON API and the built client as
static assets. No nginx, no second process.

npm workspaces, following `nzb-utils` conventions: ESM, Node ≥ 22, `tsc -b`
project references, vitest, oxlint, prettier.

```
packages/
  shared/   @playarr/shared   API request/response types, imported by both sides
  server/   @playarr/server   Fastify
  client/   @playarr/client   Vite + React
```

`shared` exists so the API contract is typechecked on both ends instead of being
restated in two places.

### Server modules

| Module      | Role                                                          |
| ----------- | ------------------------------------------------------------- |
| `coverage/` | Segment-index set arithmetic. Pure: no NZB, no I/O            |
| `download/` | The `Download` class: sparse file, coverage, anchored fetcher |
| `jobs/`     | Job directory layout, `state.json` read/write, scan on boot   |
| `config/`   | Settings store and env overlay, exposing credential providers |
| `nntp/`     | Owns the single `NntpPool`; rebuilt when settings change      |
| `routes/`   | REST handlers and the Range endpoint                          |

`coverage/` carries no NZB identifiers and no transport. Given a segment count
and an index it answers "covered?" and "next hole after k?". That is the part
most worth testing exhaustively and it can be tested with neither a document nor
a network — the same reasoning that keeps `range.ts` standalone in
`@chad3814/nzb`.

The first four modules are testable with no network and no real disk.

### Docker

Multi-stage: stage one builds client and server, stage two is `node:22-slim`
with production dependencies only. One volume at `/data`. The `@chad3814/*`
packages come from npm.

## Job lifecycle and on-disk state

A job is a directory, not a database row. Everything about it is visible with
`ls`:

```
/data/jobs/<jobId>/
  source.nzb        exactly what was uploaded
  state.json        the only mutable state
  Some.Film.mp4     sparse; ls reports 7.29 GiB, du reports what is real
```

`state.json` is the complete persisted schema. No other state survives a
restart:

```ts
interface JobState {
  id: string;
  createdAt: string; // ISO 8601
  nzbName: string; // as uploaded
  status: 'uploaded' | 'ready' | 'paused' | 'completing' | 'complete' | 'failed';
  failure?: { code: string; message: string };
  selection?: {
    fileIndex: number; // index into nzb.files
    name: string; // resolved output filename
    size: number; // authoritative, from =ybegin
    // field names mirror SegmentGeometry from @chad3814/nzb exactly
    geometry: { segmentSize: number; lastSegmentSize: number; segmentCount: number };
    covered: [number, number][]; // half-open segment-index runs
    dead: number[]; // segments the provider no longer has
  };
}
```

`covered` is half-open, matching `--range` in `nzb-cli`. In practice it holds two
or three runs: head, tail, and wherever the fetcher currently is.

### Filename resolution

The yEnc header is authoritative and the subject is a guess, so the header wins —
except that obfuscated posts randomise `=ybegin name=` per article, which yields
an extensionless random string. So `selection.name` is the header's name, unless
the header name has no extension and the subject's hint offers one that does.
This is the rule `nzb-cli` already settled on, for the same reason: writing an
extensionless random string to disk gives a file nothing can open.

Candidate filtering — deciding which files are MP4s — matches against the
subject hint at list time, because the header name is not known until a file is
probed and probing every file costs one article each.

A fully obfuscated post may have no usable extension in any subject, in which
case nothing matches and the list would be empty. So: when no candidate matches,
every file is offered as selectable, with a note that the names could not be
determined without fetching. Selecting one probes it, and if the resolved name
is not an MP4 the select fails with a message rather than starting a job that
cannot play. One wasted article is a much better outcome than a list that
wrongly says the NZB is empty.

### Lifecycle

`uploaded` costs no network at all. The NZB is parsed and the candidate list
comes from `subjectHints`, exactly as `nzb inspect` does.

Selecting a file is the first thing that touches the provider. `openNzbFile`
probes segment 1 for the authoritative name and size; the sparse file is
truncated to that size; segment 1 is written to disk (already paid for, so it is
free); the last segment is fetched so a back-loaded `moov` atom is present. The
job is then `ready`. Two articles to a playable file, whichever end the `moov`
sits at.

`paused` means no live fetcher. `completing` means holes are being filled from
the lowest index up. `complete` means every fetchable segment is on disk and the
file can be downloaded. `failed` carries a code and a message.

`complete` does not mean intact. Dead segments cannot be filled, so a job with a
non-empty `dead` list still reaches `complete` — the alternative is a file that
can never be downloaded because of one expired article. The job detail reports
the dead byte ranges, the UI warns before downloading, and the download proceeds.

Which job is active is not persisted. The server holds one `activeJobId` in
memory, and job responses carry a derived `active: boolean` so the client can
tell a `ready` job that is fetching from a `ready` job that is merely selected.
After a restart nothing is active.

### Durability

`state.json` is written to a temp file and renamed, debounced to about once a
second, and flushed immediately on any status transition and on shutdown. The
debounce exists to avoid a write per 4 MiB article; it must never be the reason
a status change is lost.

This matters more than it looks. A hole in a sparse file reads back as zeros,
indistinguishable from real zero bytes, so `covered` is the only thing that knows
what is true. If it is missing or unparseable at boot the job is marked `failed`
rather than guessed at — silently serving zeros as video is worse than an error.

Boot scans `/data/jobs/*`, reads each `state.json`, and rebuilds the index.
Nothing resumes automatically; jobs come back `paused`.

### Two costs, named rather than hidden

- **Resuming costs one article.** `openNzbFile` has no entry point that accepts
  already-known geometry, so re-opening a handle re-probes segment 1 even though
  everything it returns was persisted. About 4 MiB per resume.
- **A dead segment is permanent.** When the provider answers `430`, that region
  stays a hole for the life of the job. Playback continues and the UI reports
  which byte ranges are corrupt. This is where PAR2 would eventually plug in.

## The streaming core

One class, `Download`, owns the active job: the `NzbFileHandle`, one write
`FileHandle` on the sparse file, the coverage set, and a waiter registry.

Every anchor lands on a segment boundary, so `segmentOf(pos)` is
`Math.floor(pos / segmentSize)` and every fetched chunk is exactly one article.
Coverage is therefore an integer index set, not byte-range arithmetic.

### The fetcher

A single loop, and the only writer to the file descriptor:

```ts
for await (const chunk of handle.slice(anchorSegment * segmentSize)) {
  await fd.write(chunk, 0, chunk.byteLength, offset);
  coverage.add(segment);
  notify(segment);
  if (reanchorRequested) break; // generator returns; fetching stops
}
```

Async iteration rather than `writeTo` specifically because it can be stopped.
`writeTo` would be faster — it hands articles over as they arrive with no
head-of-line blocking — but it runs to completion, and every seek needs to
abandon the read in progress. Ordered delivery is the price of cancellation, and
the cost is bounded by the prefetch depth.

`prefetch` is set to the pool's connection count. Beyond that the surplus
requests queue in the pool while still holding decoded articles.

### Re-anchoring is not eager

An abandoned read cannot cancel fetches already in flight; they settle and are
discarded. So every re-anchor throws away up to `prefetch` articles, which on a
1 MiB/s link is real money.

The rule: if the wanted segment is ahead of the fetcher by less than the prefetch
depth, wait, because it is already coming. Re-anchor only on a genuine seek —
backwards, or forwards past the window. Nudging the scrubber forward one second
costs nothing; jumping to 80% costs the window.

### The reader

One async generator per HTTP response. It reads from disk, never from the fetch
stream:

```
pos = rangeStart
while pos < rangeEnd:
    seg = segmentOf(pos)
    if not covered(seg) and not dead(seg):
        download.want(seg)            # may re-anchor
        await download.waitFor(seg)   # parks until notify(seg)
    yield positional read of [pos, min(rangeEnd, endOf(seg)))
    pos = ...
```

Two consequences follow from readers going through disk, and both are
load-bearing:

- **Backwards seeks are instant and free.** Covered segments never re-enter the
  network path.
- **The response is not the download.** Chrome opens `bytes=0-`, buffers,
  aborts, and re-requests from a later offset, continuously. The fetcher's
  lifetime is tied to the job being active, not to any HTTP response, so an
  aborted response does not stop the file from completing and pausing the video
  does not pause the download.

A reader that goes away deregisters its waiter; the fetcher is unaffected.

Dead segments are read from disk like any other, which yields zeros. The player
gets a few seconds of garbage and keeps going, rather than hanging forever on
articles that no longer exist.

### HTTP semantics

`Accept-Ranges: bytes` on every response. `206` with
`Content-Range: bytes N-end/size` for a range request; `200` with the full
length for a bare `GET`; `416` when the start is at or past the end; `HEAD`
returns the headers with no body so the player learns the length cheaply.
`Content-Type: video/mp4`.

Nothing is buffered in memory. The body is a stream, so a slow client's
backpressure propagates back to the disk reads.

## API

| Method      | Path                       | Notes                                                                    |
| ----------- | -------------------------- | ------------------------------------------------------------------------ |
| `POST`      | `/api/jobs`                | multipart `.nzb`. Parses, stores, returns candidates. No network.        |
| `GET`       | `/api/jobs`                | Job list                                                                 |
| `GET`       | `/api/jobs/:id`            | Job detail                                                               |
| `POST`      | `/api/jobs/:id/select`     | `{ fileIndex }` → probe, truncate, fetch first and last. Becomes active. |
| `GET`       | `/api/jobs/:id/stream`     | The Range endpoint                                                       |
| `GET`       | `/api/jobs/:id/events`     | SSE: `{ status, covered, size, bytesPerSecond, dead }`                   |
| `POST`      | `/api/jobs/:id/complete`   | Fill every fetchable hole from the lowest index up                       |
| `GET`       | `/api/jobs/:id/download`   | `409 { missing }` unless `complete`, else an attachment                  |
| `DELETE`    | `/api/jobs/:id`            | Stop the fetcher, remove the directory                                   |
| `GET`/`PUT` | `/api/settings`            | GET returns `hasPassword: boolean`, never the value                      |
| `POST`      | `/api/settings/test`       | Open one connection, authenticate, report                                |

`bytesPerSecond` on the SSE stream is an exponential moving average over
completed segments.

## Configuration and credentials

Host, port, security, and connection count come from environment variables, with
a settings page in the UI as the fallback for a user who would rather not edit
`docker-compose.yml`.

Credential resolution is
`chain(fromEnv('NNTP_PASSWORD'), fromFile('/run/secret/nntp_password'), fromConfigStore())`
— the CLI's chain minus `fromPrompt`, which has no meaning without a TTY. So the
settings page is the last resort: set the environment variable or mount the
secret and nothing is ever written to the volume.

When the page is used, the password is written to `/data/config.json` at mode
`0600`, in plaintext. Stated plainly rather than implied: this is what Sonarr and
SABnzbd do, and it is a reasonable trade for a service that runs on your own
machine, but it is a plaintext credential on a volume and the environment
variable is the better path.

`GET /api/settings` returns `hasPassword: boolean` and never the value. Changing
settings destroys and rebuilds the pool. Errors from the pool never carry the
credential — `@chad3814/nntp` guarantees that, and this app does not undo it by
logging request bodies.

A configuration that is unusable does not fail at boot; it fails at select time
with a `412`, so the container starts and the settings page is reachable.

## Client

Vite, React, TypeScript. Two screens and a settings dialog. State is `useState`
plus a small `useEventSource` hook — six endpoints and one stream does not
justify a data-fetching library.

**Library.** A dropzone and the job list. Dropping a `.nzb` parses it in the
browser with `@chad3814/nzb-parser`, which has no `node:` imports and no runtime
dependencies, and renders the file list immediately — before any upload
completes. The upload then runs in the background. MP4 entries are selectable;
everything else is listed and disabled.

**Player.** `<video controls src="/api/jobs/:id/stream">` with a coverage bar
underneath fed by SSE, and a throughput readout. The bar matters more here than
in an ordinary player: re-anchored seeking means the file genuinely has holes,
and showing which parts exist explains both why one seek was instant and why
another region looks broken. Dead regions are marked distinctly from
not-yet-fetched ones.

On `ended`, a dialog offers Download or Delete. Download runs `/complete` with
progress first if anything is missing.

## Failure handling

| Failure                            | Behaviour                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `geometry.uniform === false`       | Job → `failed` at select. Variable article sizes mean byte offsets cannot be computed; `resolveRange` refuses outright, and guessing would serve bytes from the wrong place silently. |
| `430` — article gone               | Segment → `dead`, fetcher continues at the next one. Reader serves zeros. UI marks the region. Never stalls.                                                                         |
| CRC mismatch under `verify: true`  | Retry the article once, then treat as `dead`.                                                                                                                                        |
| `NntpCredentialError`, auth failure | Surfaced on settings-test and on select. The job stays `ready` — a wrong password is not a broken job.                                                                               |
| `NntpCapacityError`                | The pool shrinks its own limit. Surface `pool.failures` in settings so the real cap is visible rather than silent.                                                                   |
| `ENOSPC`                           | Pause the fetcher, job → `failed` with a plain message. Do not retry into a full disk.                                                                                               |
| Malformed NZB                      | `400` carrying the parser's own message unmodified. It is strict by design and its errors are specific.                                                                              |
| Unconfigured provider              | `412` on select; the client opens settings.                                                                                                                                          |
| Corrupt or missing `state.json`    | Job → `failed` at boot. The sparse file alone cannot say what is real.                                                                                                               |

## Testing

Every feature ships with unit tests. Lint, typecheck, test, and build all pass
before any task is considered done.

- **`coverage/`** — exhaustive and pure. No document, no network, no disk.
- **`Download`** — against a synthetic in-memory `ArticleSource` built the way
  `packages/nzb/test/post.ts` does it: real yEnc articles with CRCs from
  `node:zlib`, so a fixture cannot agree with a broken decoder by construction. A
  recording source makes "which articles did that cost?" a plain assertion, which
  is what the interesting cases are: a forward seek within the prefetch window
  issues no re-anchor; a backwards seek into covered bytes issues zero article
  requests; a `430` yields a dead segment and the loop continues; coverage
  survives a `state.json` round-trip.
- **Routes** — `app.inject()` for Range semantics: `206` with a correct
  `Content-Range`, `200` on a bare `GET`, `416` past the end, `HEAD` with no
  body, and open-ended `bytes=N-`.
- **`jobs/`** — boot scan over a fixture directory, including the corrupt-state
  case.
- **`config/`** — provider chain precedence, and that a password never appears in
  a `GET /api/settings` response.
- **Client** — vitest and `@testing-library/react`: dropping a `.nzb` renders the
  file list with the network stubbed out entirely, which is what proves the
  in-browser parse path is real and not a round trip.
- **`scripts/smoke.ts`** — opt-in, against a live provider, mirroring what
  `nzb-utils` does. Never in CI.
