# Docker smoke test — implementation notes

> Agent-facing reference for [`docs/features/docker-smoke-test.md`](../../features/docker-smoke-test.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

`Dockerfile` uses a build stage to install dependencies and compile the Preact frontend. Its runtime stage runs as the unprivileged `node` user, stores app data in `/data`, and exposes mouaif on port `5732`. The runtime stage also ships **Google Chrome** (the `stable` channel, installed at `/opt/google/chrome/chrome`) so an agent session inside the container can drive and inspect the UI through the `chrome-debug` MCP server and the Inspector tab. Chrome runs headless as `node`; it needs `--no-sandbox` in a container, enabled via `PUPPETEER_DANGEROUS_NO_SANDBOX=true`, and `MOUAIF_CHROME_URL=http://127.0.0.1:9222` points mouaif's Inspector/`webpreview` bridge at that same CDP endpoint.

The build stage copies `package.json`, `package-lock.json`, `scripts/patch-zimmerframe.js`, and `scripts/prepare-web.js` **before** `npm ci`. The install is not a plain dependency fetch: `postinstall` runs the zimmerframe patch and `prepare` runs the web-UI check, so both scripts must be on disk when the install layer runs. A missing lifecycle script is a **hard failure** on current npm (`Cannot find module '/app/scripts/prepare-web.js'`) rather than the warning older npm tolerated, which is why those two files are copied explicitly instead of relying on `COPY . .` later in the build.

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
