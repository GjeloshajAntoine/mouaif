# Cloud model providers — implementation notes

> Agent-facing reference for [`docs/features/cloud-providers.md`](../../features/cloud-providers.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Source: [src/ai-endpoints.js](../../src/ai-endpoints.js) — four new `ENDPOINTS` entries with `chatPath`, `authHeader`, `listModels`, plus `BUILDERS` / `PARSERS` rows pointing at the existing OpenAI-shaped builder/parser. Azure additionally appends `api-version` in `buildOpenAIRequest`.
- Settings list: [frontend/src/api.js](../../frontend/src/api.js) `SETTINGS_PROVIDERS` — one row per provider with `label`, `defaultBaseUrl`, `hint` (no `oauth` flag).
- Auth mapping: [src/auth.js](../../src/auth.js) `AI_TO_AUTH_PROVIDER` — each maps to its own keyring namespace; there is **no** `SUPPORTED_PROVIDERS` entry for these API-key-only providers (they are never offered an OAuth / keychain account, so `serviceName` is never called on them).
- No new REST endpoints; the server wiring (`/api/ai/models/live`, `/api/ai/chat`) iterates `ai.ENDPOINTS` and needs no provider-specific code.
- Tests: [scripts/test-model-lists.js](../../scripts/test-model-lists.js) covers the new adapters (URLs, headers, error mapping, builder shape).
