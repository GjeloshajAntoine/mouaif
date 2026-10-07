# UI review in Docker

## Overview

`compose.ui-review.yaml` starts the production image next to its own headless Chrome, so the mobile UI can be exercised and captured at real phone widths inside a container without touching the host's app store or its debug Chrome.

## Usage

Build the image once, then start the stack from the repository root:

```bash
docker build -t mouaif-app:latest .
docker compose -f compose.ui-review.yaml up -d
```

The UI is then served on <http://127.0.0.1:5732/>, and the app reaches its container-local Chrome over `MOUAIF_CHROME_URL=http://chrome:9222`.

Stop the stack and drop its isolated data volume when finished:

```bash
docker compose -f compose.ui-review.yaml down --volumes
```

## What the stack gives you

- **The production image, not a dev server.** Both services run `mouaif-app:latest`, so what you review is the built UI the way a release ships it.
- **Its own state.** App settings, chats, and transcripts live in the `ui-review-data` volume, so a review session cannot read or overwrite the host's `~/.mouaif/store.sqlite`.
- **Its own browser.** The `chrome` service runs headless Chrome with the debugging port open on the compose network only. The host already uses `127.0.0.1:9222` for the dev inspector, so the two never collide and no host port is published for Chrome.
- **Read-only project.** `examples/docker-test-project/` is mounted at `/workspace/example`, so reviewing the UI leaves the repository fixture unchanged.
- **An empty home for new roots.** `MOUAIF_ALLOW_ANY_ROOT=1` lets the in-container server register a project outside its default root, which is what an isolated review of a mounted fixture needs.

## Notes

- The published `5732` is the same default port the CLI uses, so stop a host-side `mouaif serve` before starting the stack, or the app container cannot bind it.
- The healthcheck polls `/api/settings` before the stack is reported up, so a script can wait on `docker compose ... up --wait` and know the UI answers.
- Build the image yourself first. The stack references `mouaif-app:latest` rather than a `build:` section, so a review reuses one image across runs instead of rebuilding per start.
