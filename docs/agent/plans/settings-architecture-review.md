# Settings architecture: fixes left after the review of steps 1–7

Review of commits `d12b1989..5d52ee99` against [settings-architecture.md](settings-architecture.md). Date: 2026-11-14.

Already fixed (uncommitted at the time of writing): a `.mcp.json` that is valid JSON but not an object crashed the MCP server list, and the `test:content` files were not part of `npm test`.

## Outcome (2026-11-14)

| # | Result | Commit |
| --- | --- | --- |
| — | Non-object `.mcp.json`, `test:content` in `npm test` | `93d1b16e` |
| 1 | Kept: a share caller cannot write hooks. Routes answer 403 (was 500), test added, documented in `hooks.md` and the step 6 row | `e5c541cf` |
| 2 | Kept: the key is dropped on a `baseUrl` change for every actor. Test for `ui`, documented | `26c157bf` |
| 3 | Server lists and the authorization block go through `writeType`; new types `mcpAuthorization`, `projectMcpAuthorization`; session stop is an `afterWrite`. A share caller can no longer add, edit or remove servers (it could edit an app server's command) | `e1a6ca77` |
| 4 | `PUT /api/hooks` returns `changes` | `20a4a5fc` |
| 5 | The first theme save leaves `themes.active` absent | `cc168663` |
| 6 | `setProjectMode` copies settings, then moves the MCP row, then flips the mode | `4120b7c5` |
| 7 | Cause: `32a8d84e` (share) was written on stale copies of eight files and reverted work from about eight earlier commits, including the lazy hook cwd. Restored by three-way merge | `39732de1` |
| 8 | Five wired into `npm test`, foldable into `test:browser-build`, Docker check as `test:ui-review-docker`, the extension fixture listed as a helper | `b47c85eb` |

## To do (as written by the review)

| # | Fix | Where | Size |
| --- | --- | --- | --- |
| 1 | Decide and document that a shared project's caller cannot write hooks | `src/content/registry.js`, `src/chatHooks.js`, `docs/features/hooks.md` | Small |
| 2 | Decide whether a UI write drops a stored API key when `baseUrl` changes | `src/content/service.js` (`carrySecrets`) | Small |
| 3 | Send MCP writes through the write path | `src/mcp.js`, `src/tools/authorization.js` | Medium |
| 4 | Return the change list from `PUT /api/hooks` | `src/server-handlers-hooks.js` | Small |
| 5 | Stop the first theme save reporting an "Active theme" change | `src/themes.js` or `src/content/service.js` | Small |
| 6 | Make the storage-mode switch safe when the settings write fails | `src/content/stores/index.js` (`setProjectMode`) | Small |
| 7 | Repair `test-hooks.js` (fails before the plan too) | `scripts/test-hooks.js`, `src/ai-stream.js` | Unknown |
| 8 | Wire or exempt the unwired test files (fails before the plan too) | `package.json`, `scripts/test-test-coverage.js` | Small |

### 1. Share callers and hooks

- Both hook types declare `writers.share: false`, and `writeMany` detects a remote caller on its own (`isRemoteCall`).
- Result: a full-access remote caller who promotes a chat hook to project or app scope (`chatHooks.promote`) is now refused with 403. Before step 6 the hook was written.
- Step 6 of the plan says "None intended". The new behaviour is the safer one, so the likely fix is to keep it.
- This was traced by reading the code, not run.
- To do:
  - Add a test: promote as a share caller is refused, and the chat hook is still there afterwards.
  - Check the error the remote user sees in the chat hooks UI.
  - Add the rule to `docs/features/hooks.md` and to the step 6 row of the plan.

### 2. Stored API key dropped on a `baseUrl` change from the UI

- `carrySecrets` applies the bound-field rule to every actor. Before step 4 only `update_settings` did (`dropKeyOnRedirect`); the settings routes always kept the stored key.
- Reproduced: `applyPatch({ scope: 'app', actor: 'ui', patch: { providers: [{ id, baseUrl: <new>, hasApiKey: true }] } })` stores the provider without its key.
- No frontend caller sends `providers` through `PUT /api/settings/app` today, so the exposure is the raw project editor re-sending `models` with a changed `baseUrl`.
- The plan's design text asks for this rule, but the step 4 row does not list it as a behaviour change.
- To do: either keep it and document it (plan step 4 row, `app-and-project-settings.md`, a test for the `ui` actor), or limit the drop to `tool` and `share` as before.

### 3. MCP writes bypass the write path

- `mcp.js` (`mergeInto`) and `tools/authorization.js` (`writeMcpConfig`) call `store.write` directly.
- So MCP changes get no policy check, no change list and no `content_changed` event, and `projectMcpServers` declares `approval` and `writers` that nothing enforces.
- This is inside step 7 as written (storage only), but the design sections 3 and 4 of the plan expect it.
- To do:
  - Write servers through `collection.replace` / `service.writeType` for `mcpServers` and `projectMcpServers`.
  - Move the server restart to an `afterWrite` registered with `service.onWrite`.
  - Decide how the `authorization` block is declared (it has no registry type today).
  - Until then, change the plan's status line to say MCP uses the stores but not the write path.

### 4. `PUT /api/hooks` discards the change list

- `hooks.setConfig` returns only the config; `writeConfig` has the changes.
- To do: call `writeConfig` in the route and add `changes` to the response, as the settings routes do.

### 5. First theme save reports an "Active theme" change

- `themes.writeStore` always writes `themes.active` as `''` when no theme is active. When the key was never stored, `writeMany` compares `undefined` with `''` and emits a `set` change.
- To do: treat `undefined` and `''` as the same for this type, or pass `undefined` when there is no active theme and none was stored.

### 6. Storage-mode switch can stop half way

- `setProjectMode` calls `projectMcp.moveMode` (writes `.mcp.json`, deletes the DB row) before it copies the settings document.
- If the settings write then throws, the project is still in DB mode but its MCP row is gone. The servers are not lost (the file is read in both modes), but the state is not what either mode expects.
- To do: copy the settings first and move the MCP row last, or wrap both in a try that restores the row.

### 7. `test-hooks.js` fails

- `testLookupCost` asserts that a tool call with no hooks does not resolve the chat's working folder; it resolves once (`scripts/test-hooks.js:197`).
- It fails the same way at `6a8db537`, the commit before the plan's code, so the plan did not cause it.
- The file stops at that assertion, so every test after it is not run, including whatever step 6 relied on from `test:hooks`.
- To do: find which `resolveForCall` call in `src/ai-stream.js` now runs without a hook, fix the code or the test, then re-run the whole file.

### 8. Unwired test files

`test-test-coverage.js` fails on test files that no npm script references. None are the new content tests. Found by a quick name match:

- `test-chat-stop-cancellation.js`
- `test-extension-server.js`
- `test-file-editor-breadcrumb.js`
- `test-foldable-layout.mjs`
- `test-inspector-viewport-default.js`
- `test-shell-async.js`
- `test-ui-review-docker.js`

The test itself reports 8, so one more is missing from this list; run it to get the exact names. To do: add each to a script, or to the exempt or `BROKEN_TESTS` list with a reason.

## Not checked in the review

- `test-share-e2e.js`, the browser `.mjs` tests and the Docker UI test were not run.
- The full `npm test` was not run after `test:content` was added to it.
- The keys in the `SettingsDefaults` patch objects were not expanded one by one; the other four `saveApp` callers send client-visible keys.
