# Working in mouaif

Code conventions (commits, mobile-first UI, docs) are in `.agents/skills/mouaif-dev/SKILL.md`, and component rules are in `.agents/skills/react/SKILL.md`.

## Machine resources

The dev host is small: 4 cores and about 4 GB of RAM. It only runs these, and dev work reuses them:

- the prod mouaif (`:8080`)
- one debug Chrome on `127.0.0.1:9222`, with a few tabs
- the small test container (`mouaif-app-1` / `mouaif-chrome-1`, test mouaif on `:5732`)

Rules:

- **Don't start copies.** No extra `mouaif serve` on another port, no second Chrome, no mockup or preview server. To check a change in a browser, open a tab in the `:9222` Chrome (the `chrome-debug` MCP) on the test mouaif.
- **Test in the Docker app, not on prod.** The test mouaif (`:5732`) runs the baked `mouaif-app:latest` image, so it shows none of your source changes until you rebuild: `nice -n 19 docker build -t mouaif-app:latest .` (one build at a time), then `docker compose -f compose.ui-review.yaml up -d` to recreate the containers. Don't judge a change on prod `:8080`: restarting it signs the browser out and the agent has no credentials. See `docs/features/ui-review-docker.md`.
- **Chrome MCP connects, it doesn't launch.** Use `chrome-devtools-mcp --browser-url=http://127.0.0.1:9222`, never `--isolated` or `--headless`, because those start a new Chrome each time.
- **Browser test scripts launch their own Chrome.** About 20 `scripts/test-*-ui*.mjs`-style scripts start a Chrome with a `/tmp/mouaif-*` profile. They clean up when they finish, but leave the Chrome and its profile behind if they're killed. Run them one at a time, only when needed, and delete their `/tmp` profile if a run is interrupted.
- **If the chrome-debug MCP times out**, first check the tabs. When memory runs out, the kernel kills tab renderers, and a dead tab hangs every client that attaches to it. List the tabs at `http://127.0.0.1:9222/json/list`, then replace any tab that doesn't answer (`Target.createTarget` with the same URL, then `Target.closeTarget` on the old one). Don't start a second Chrome.
- **Stop what you start.** If a throwaway process can't be avoided, check that nothing already serves it, keep its pid, and stop it before you finish the turn. A `mouaif serve` supervisor that loses the port race restarts its worker about once a second, indefinitely.
- **Build gently.** Check `uptime` first, run `nice -n 19 npm run build:web`, and never run two builds at once.
- **Leave the prod `:8080` process and the containers alone.** Never kill or restart them as a side effect of dev work.
