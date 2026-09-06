# Docker smoke test

## Overview

The Docker smoke test builds a production mouaif image, starts the server with isolated storage, mounts an example project, and validates the built UI and core project, file, chat, and message APIs.

## Usage

Docker with the Compose plugin is required. Run the complete test from the repository root:

```bash
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
```

Remove the containers and isolated test volume afterward:

```bash
docker compose -f compose.test.yaml down --volumes
```

A successful run ends with `Docker smoke test passed.` and exits with status zero. The example fixture is available at `examples/docker-test-project/`.

## Implementation notes

`Dockerfile` uses a build stage to install dependencies and compile the Preact frontend. Its runtime stage runs as the unprivileged `node` user, stores app data in `/data`, and exposes mouaif on port `5732`. The runtime stage also ships **Google Chrome** (the `stable` channel, installed at `/opt/google/chrome/chrome`) so an agent session inside the container can drive and inspect the UI through the `chrome-debug` MCP server and the Inspector tab. Chrome runs headless as `node`; it needs `--no-sandbox` in a container, enabled via `PUPPETEER_DANGEROUS_NO_SANDBOX=true`, and `MOUAIF_CHROME_URL=http://127.0.0.1:9222` points mouaif's Inspector/`webpreview` bridge at that same CDP endpoint.

`compose.test.yaml` starts two services:

- `app` runs the production image and waits for `/api/settings` to become healthy.
- `test` runs `scripts/docker-smoke-test.js` only after the app is healthy.

The example project is mounted read-only at `/workspace/example`. Project settings and generated chats are stored in a named Docker volume, so the repository fixture remains unchanged. The smoke test covers:

1. Serving the compiled mobile UI.
2. Opening an isolated app settings store.
3. Finding and registering the mounted example project.
4. Reading example content through the file API.
5. Creating a chat and persisting a sample conversation.
6. Listing the registered project and created chat.

No AI provider credentials or network calls to an AI service are required.
