# OpenAI Codex implementation

## Overview

The `codex` provider connects a ChatGPT account to the Codex Responses API without a local CLI. It has its own keychain namespace and is not an OpenAI Chat Completions provider.

## Usage

Run the isolated backend and mobile UI regressions:

```bash
node scripts/test-codex-provider.js
node scripts/test-codex-ui.mjs
npm run build:web
```

## Implementation notes

- `src/oauth-codex.js` uses OpenAI's public Codex client ID, requests a device code at `/api/accounts/deviceauth/usercode`, and polls `/api/accounts/deviceauth/token`. HTTP 403/404 means pending. The returned authorization code and PKCE verifier are exchanged at `/oauth/token`, using `https://auth.openai.com/deviceauth/callback`.
- Access/refresh tokens and ChatGPT account ID are stored in `mouaif/codex` in the OS keychain. Email plus workspace ID identifies the account, so distinct workspaces do not collide. JWT claims are unverified routing hints; the upstream validates authorization.
- `register()` adds the refresh-token grant to the existing proactive chat refresh path. Concurrent rotating refresh requests share one promise. The device-flow map is bounded to eight entries, expiry is 15 minutes, and cancellation aborts pending upstream polling.
- `src/server-shared.js` registers the flow at server startup. `src/server-handlers-auth.js` routes POST/GET/DELETE `/api/auth/device/codex` to it, sharing the public flow contract with Copilot. Private device authorization IDs and bearer/refresh tokens never appear in these responses.
- `src/ai-codex.js` converts system/developer messages to `instructions`, user text/images to Responses content, assistant calls to `function_call`, and tool outputs to `function_call_output`. Function specs are flattened from the existing OpenAI tool schema.
- Chat requests target `https://chatgpt.com/backend-api/codex/responses`, with `store: false`, `stream: true`, bearer authorization, and `ChatGPT-Account-Id`. The generic output cap and temperature are not sent because this backend rejects them. Prompt-cache routing uses the existing stable conversation key.
- Completed function-call output items normalize to `tool_call_delta` once; argument deltas are ignored to prevent duplicate arguments. The existing shared loop performs authorization, dispatch, history replay, and follow-up. Text, refusal, reasoning summary, usage, cache-read tokens, and error events are normalized too.
- The model catalog uses `/models?client_version=0.99.0`. That is the Codex catalog compatibility version, not mouaif's package version. Hidden rows are excluded and reasoning levels/context windows/input modalities are retained.
- `frontend/src/components/SettingsProviders.jsx` shares its device-code controls between Copilot and Codex. `deviceAuth` metadata hides the browser-redirect flow for both; Codex remains OAuth-only. Requests are guarded against editor changes while sign-in starts, and the selected provider is used for account refresh and cancellation.

Real ChatGPT authorization and inference must be verified with a user's eligible account; the automated checks use mock upstream responses, real server routing, the shared tool loop, and a real mobile-width browser.
