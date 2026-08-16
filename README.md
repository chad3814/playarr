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

## There is no authentication

None. Not a password, not a token, not a session. Anyone who can reach the
port can read and overwrite your provider settings, upload NZBs, delete jobs,
and make the server open a connection to any host and port they name (`POST
/api/settings/test`). This is a deliberate scope decision for a single-user
tool on a trusted machine, not something half-built.

So `docker-compose.yml` publishes the port as `127.0.0.1:8080:8080` — reachable
from the machine running the container and nowhere else. **Do not change that
to `8080:8080`** (or any other interface) unless you have put a reverse proxy
that authenticates in front of it. The server itself binds `0.0.0.0` inside
the container, which it has to; the publish rule is what keeps it private.

## Configuring your Usenet provider

The host and connection settings come from environment variables first, and
fall back to whatever the settings page saved. Credentials are resolved
separately, and each one is tried in this order:

1. **`NNTP_USERNAME` / `NNTP_PASSWORD` environment variables**, set in
   `docker-compose.yml` or the shell that runs it. Simple, and the password
   never touches disk inside the container — but it is visible to anything
   that can read the container's environment (`docker inspect`, `/proc`).
2. **Secret files at `/run/secret/nntp_username` and
   `/run/secret/nntp_password`.** **This is the most secure option.** Mount
   them read-only and the credential is never in the environment, never in
   `docker inspect`, and never on the data volume:

   ```yaml
   services:
     playarr:
       secrets:
         - source: nntp_password
           target: /run/secret/nntp_password
           mode: 0400

   secrets:
     nntp_password:
       file: ./nntp_password.txt # a trailing newline is trimmed off for you
   ```

   The username file works the same way, and either file can be used without
   the other.

3. **The settings page in the UI.** Simplest, but it writes your password in
   plaintext to `/data/config.json` (mode `0600`, but plaintext all the same)
   on the named volume. Anyone with access to that volume can read it.

The other provider settings — `NNTP_HOST`, `NNTP_PORT`, `NNTP_SECURITY`,
`NNTP_CONNECTIONS` — are environment variables or the settings page, and the
environment wins.

## Other environment variables

| Variable             | Default          | What it does                                                            |
| -------------------- | ---------------- | ----------------------------------------------------------------------- |
| `PORT`               | `8080`           | Port the server listens on inside the container.                        |
| `HOST`               | `0.0.0.0`        | Interface it binds. Leave it: the compose publish rule is the boundary. |
| `PLAYARR_DATA_DIR`   | `/data`          | Where jobs, their sparse files, and `config.json` live.                 |
| `PLAYARR_CLIENT_DIR` | set by the image | Static client bundle to serve. Unset outside the container.             |

A blank value is treated the same as an unset one, so compose interpolating
`${PORT:-}` into an empty string does not override the default.

## What it does not do (on purpose)

These are design decisions, not bugs:

- **MP4 only.** Choosing a file whose name turns out not to end in `.mp4` is
  refused outright (HTTP 415), and non-MP4 files are not offered in the file
  list at all — except when no filename in the NZB could be resolved without
  fetching, in which case every file is offered and the check happens once the
  real name is known. Playback still depends on the container holding a
  browser-playable codec; no transcoding happens anywhere in this project.
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
