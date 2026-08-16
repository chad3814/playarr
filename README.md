# playarr

Upload an NZB, pick the MP4 inside it, and watch it in your browser while it
downloads from Usenet — no waiting for the whole file first. When you're
done, keep the finished file or delete it.

## Running it

```sh
docker compose up
```

Then open `http://localhost:8080`. Job state and (optionally) your NNTP
password live in a named volume (`playarr-data`), so they survive a
container restart.

## Configuring your Usenet provider

There are two ways to give playarr your NNTP host and credentials:

- **Environment variables** (`NNTP_HOST`, `NNTP_PORT`, `NNTP_SECURITY`,
  `NNTP_CONNECTIONS`, `NNTP_USERNAME`, `NNTP_PASSWORD`), set in
  `docker-compose.yml` or the shell that runs it. **This is the better
  option** — the password never touches disk inside the container.
- **The settings page in the UI.** This is simpler but writes your password
  in plaintext to `/data/config.json` (mode `0600`, but plaintext all the
  same) on the named volume. Anyone with access to that volume can read it.

If both are set, the environment wins.

## What it does not do (on purpose)

These are design decisions, not bugs:

- **MP4 only.** Playback only works for a browser-playable container/codec
  combination; other files in the NZB can be selected but won't stream. No
  transcoding happens anywhere in this project.
- **Playback can stall.** If your Usenet connection's throughput is lower
  than the video's bitrate, the browser will buffer and wait — same as any
  slow connection to any video source. This is expected, not a hang.
- **Seeking creates holes.** Jumping to a new position re-anchors the
  fetcher at that point in the file rather than fetching everything in
  between, so the file on disk can end up with unfetched gaps. This is why
  "download it afterward" is a distinct step: choosing to keep a file fills
  every remaining hole before it's handed to you as complete.
- **Dead articles are permanent.** If an article is gone from your
  provider's retention (or was never posted, or fails its checksum), that
  segment is marked dead and playarr will not keep retrying it. A file with
  dead segments can still be played and can still be kept, but it will have
  a fixed, permanent gap in it.

## Not built (each its own future scope)

PAR2 repair, subtitles, disk quota/auto-cleanup, MKV, transcoding, indexer
search, authentication, multi-user.

## Development

```sh
npm install
npm run check   # typecheck, lint, format check, tests
npm run build   # compiles server + shared, builds the client bundle
```

`npm run smoke` is a separate, opt-in script that talks to a real NNTP
provider (see `scripts/smoke.ts`). It is never run as part of `npm run
check` and never runs in CI.
