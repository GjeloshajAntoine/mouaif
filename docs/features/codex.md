# OpenAI Codex

## Overview

Use Codex through your ChatGPT plan, without an OpenAI API key or a local Codex CLI. The **OpenAI Codex** provider uses ChatGPT device authorization and the Codex Responses API, including streamed text, reasoning, images as input, and mouaif tool calls.

## Usage

1. Enable **Device code authorization** in ChatGPT **Settings → Security**, if your account requires it. A ChatGPT account with Codex access is required; workspace policy may restrict device sign-in.
2. Open mouaif **Settings → Providers → Add provider** and choose **OpenAI Codex**.
3. Tap **Sign in with ChatGPT code**, copy the displayed code, and open the ChatGPT sign-in link. Only approve a code you requested yourself.
4. Return to mouaif, select the signed-in account, and tap **Add provider** (or **Save** when editing). With one account, automatic selection works.
5. Choose a model from the provider's live catalog in a chat, or configure a project model referencing the `codex` provider.

Device sign-in works from a phone, LAN connection, or reverse proxy: it does not redirect to localhost. Codes expire after 15 minutes. Cancel stops the pending sign-in; leaving the provider editor cancels it too.

If ChatGPT approves the code but mouaif has lost the sign-in session (for example, after a server restart), the editor shows **The sign-in session was lost. Start sign-in again.** instead of staying pending. Start a new attempt and approve the new code. An expired mouaif app login is also reported; temporary network errors, rate limits, and server errors are retried until the code expires.

### Model picker

The model list comes from the Codex catalog endpoint, which answers according to the client version the request advertises. A version below the floor OpenAI currently serves returns no usable rows, so mouaif asks for the newer of its own version and `0.150.0`. If the catalog still comes back empty, the picker reports it as a model-list failure (`Codex returned no available models for client_version …`) rather than as an empty list, which is what a stale version used to look like.

A model typed by hand into a project still works even when the picker is empty, because chat does not read the catalog. Chatting with a known model id is a way to tell a catalog problem from an authorization one.

For API-key access to OpenAI models, use **OpenAI compatible** instead. Codex is OAuth-only. ChatGPT plan limits and model availability are controlled by OpenAI. The generic maximum-output-token setting is not forwarded because the Codex endpoint does not support that field.

## Behavior

- Access and refresh tokens are held in the app SQLite credential table, not the settings JSON returned to clients. Expiring chat credentials refresh automatically. See [Credential storage](./credential-storage.md) for migration and backup security.
- The live catalog excludes hidden models and preserves context windows and reasoning levels when provided. It is read from the Codex catalog endpoint, which selects the model set by the `client_version` the caller advertises: a release older than roughly `0.150` is answered with the hidden `codex-auto-review` row alone. mouaif therefore requests the newer of its own version and that floor, so a pinned version cannot silently empty the picker, and an empty answer is reported as an upstream error instead of "no models".
- Tool calls use mouaif's normal authorization and multi-turn behavior. Cached input tokens are reported separately.
- The ChatGPT backend is distinct from the public OpenAI API; endpoint and sign-in behavior may change upstream. Real-account sign-in and model access depend on your plan and workspace policy.

## Sign-in diagnostics

The server writes a bounded snapshot of the most recent sign-in activity to `<mouaif app home>/codex-sign-in.json` (normally `~/.mouaif/codex-sign-in.json`, or under `MOUAIF_HOME` when overridden). It is overwritten at each stage and created with owner-only permissions. Diagnostic write failures do not interrupt sign-in.

The snapshot contains only the timestamp, local flow ID, status, stage, poll count, HTTP status when available, and a fixed error category or network-failure flag. It never records device codes, upstream device IDs, authorization codes, PKCE verifiers, tokens, account details, headers, upstream response bodies, or raw error messages.

Use it during a fresh attempt to distinguish waiting for approval (`poll_approval_response`, HTTP 403/404), token exchange, account validation, database storage (`store_credentials`), and completion. In-progress requests show their stage before the response arrives. A snapshot survives restart, but the pending sign-in session itself does not; another attempt overwrites the snapshot.

## REST endpoints

These endpoints expose only the public flow status, never access/refresh tokens or the private device authorization ID:

- `POST /api/auth/device/codex` starts sign-in and returns `{ id, status, userCode, verificationUri, expiresAt, account, error }`.
- `GET /api/auth/device/codex?id=<id>` returns the same shape. Status is `pending`, `ok`, `expired`, `cancelled`, or `error`.
- `DELETE /api/auth/device/codex?id=<id>` cancels a flow and returns `{ ok }`.

Account listing and local sign-out use the existing `/api/auth/accounts` endpoints. Local sign-out clears the app DB credential; it does not revoke authorization at OpenAI. Live model discovery uses the existing `/api/ai/models/live?provider=codex` endpoint.
