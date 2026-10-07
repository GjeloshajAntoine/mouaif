# UI review in Docker — implementation notes

> Agent-facing reference for [`docs/features/ui-review-docker.md`](../../features/ui-review-docker.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

`compose.ui-review.yaml` is a sibling of `compose.test.yaml` and shares its shape (same production image, same mounted fixture) but a different purpose: `compose.test.yaml` builds the image and runs `scripts/docker-smoke-test.js` as a one-shot against it, while this file starts no test service at all. It exists so a UI review can drive the running app in a browser.

### Services

| Service | Image / entrypoint | Job |
|---------|--------------------|-----|
| `app` | `mouaif-app:latest`, default `CMD` (`node bin/mouaif.js serve --host 0.0.0.0 --port 5732`) | Serves the built UI and the REST + SSE surface |
| `chrome` | `mouaif-app:latest` with `entrypoint: google-chrome` and `--headless=new --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --no-sandbox --disable-gpu --disable-dev-shm-usage` | A CDP endpoint on the compose network for the Inspector and `webpreview` |

Both services reuse one image because the runtime stage of `Dockerfile` already installs Google Chrome. There is no second image and no Chrome download at `up` time.

### Environment

- `MOUAIF_HOME=/data` — app store inside the volume, never the host's `~/.mouaif`.
- `MOUAIF_CHROME_URL=http://chrome:9222` — the Inspector and `webpreview` bridge target the compose-network Chrome. The host's debug Chrome on `127.0.0.1:9222` is left alone.
- `MOUAIF_ALLOW_ANY_ROOT=1` — lets the container register the mounted fixture at `/workspace/example` as a project.

### Wiring details

- `chrome` publishes **no host port**. Publishing `9222` would collide with the host debug Chrome that `npm run test:chrome` and the chrome-debug MCP server use. The dev-time CDP client runs on the host, so it must reach Chrome through the host's own `127.0.0.1:9222`, not through this stack.
- `app` publishes `5732:5732`, the CLI default. Starting the stack therefore requires the host port to be free; a host-side `mouaif serve` must be stopped first. The agent rules forbid the agent from stopping it, so treat "port already allocated" as a user decision, not a bug.
- `depends_on: chrome: condition: service_started` only orders startup. It is deliberately not `service_healthy`: the `chrome` service has no healthcheck, and starting the app is not gated on a CDP handshake.
- The healthcheck uses `node -e` with `fetch('http://127.0.0.1:5732/api/settings')`. Node 22 in the image (and in the host toolchain) has global `fetch`, so no `curl`/`wget` needs to be present in the runtime image.
- The volumes are named (`ui-review-data`), not bind mounts, so a review's chats cannot land in the repository working tree.

### Volume and fixture

`./examples/docker-test-project` is mounted read-only at `/workspace/example`, matching `compose.test.yaml`. The data volume is separate (`ui-review-data` vs `test-data`), so a review session and a smoke-test run cannot corrupt each other's store.

### Verification

```bash
docker compose -f compose.ui-review.yaml config   # validates the file and interpolation
docker compose -f compose.ui-review.yaml up -d --wait
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5732/
docker compose -f compose.ui-review.yaml down --volumes
```

The stack is not run by `npm test`: it needs Docker, a built image, and the host port. Nothing in `scripts/` references it.
