# Track C — model-choice landing notes

## Overview

Implemented on `feat/track-c-model-choice-d45b1f23`, isolated from committed `d45b1f23`. No master edits, merges, pushes, dependency installs, server CLI restarts, or live provider/model policy changes.

## Shipped

- Existing all-provider chat/image catalog search, provider chips, agent pins, default-agent editor and app-wide pin/recent sections reused.
- Optional `subagentProviderId` / `subagentModelId` chat and resolved project defaults, edited in Project settings → Agents (chat control appears when opened from a chat).
- One resolver with explicit precedence: approval → selected agent pin (defaultAgent only for unnamed calls) → chat default → resolved project default → chat model. Only the winning model pin resolves; unknown personas still fail.
- Approval cards show the winning provider/model/source and comparison with the chat model, including recovered requests. Displaying a default or changing only thinking never makes it a model override.
- Agent list summaries, nullable SQLite persistence, existing `update_chat`/REST field support, docs/changelog and matching committed frontend/published docs artifacts.

## Verified

- `npm run lint`, explicit syntax checks for changed server/test/card files and Vite compilation of changed JSX.
- `npm run test:subagent-model-choice`: precedence table, dispatch, safe provider hydration, default/named agent separation, app/project inheritance/masking, chat persistence/clear, native update fields, REST agent/chat/project handlers and recovered approvals. Providers/stores are fixture-only.
- `npm run test:subagent-prompt`, `node scripts/test-agents.js`, `npm run test:mouaif-tool`, `node scripts/test-tool-authorization.js`, `node scripts/test-project-model-safety.js`, `node scripts/test-tool-groups.mjs`.
- `node scripts/test-agent-page-flow.mjs`: existing in-process serve flow, editor create/rename/reload; no host CLI restart.
- `node scripts/test-project-settings-render.mjs`, `node scripts/test-project-settings-ui.mjs`, `node scripts/test-chat-list-draft-payload.js`, static containment/compression checks.
- Chrome fixture at 360 px: approval/default/list discoverability, no horizontal overflow, default control touch targets ≥44 px, picker choose/clear, no writes on mount, failed save preserves prior value, ghost/empty catalogs and unchanged pin/recent behavior. Project-settings regression covers 360/390/430 px. Local defaults screenshot visually reviewed.
- `npm run build:web`, `node scripts/test-docs-links.js`, `npm run docs:build`, `npm run docs:publish:check` after refreshing generated docs.

## Landing coordination and open work

C adds no tool names and must not alter A/E’s eventual tool count. Land serially after A/E per the corrected plan; no merge is performed here. Shared conflicts: `src/ai-stream.js` (A/D dispatch), `src/tools/authorization.js` (A/E pending requests), `src/tools/appToolNames.js` / `mouaif.js` (E fields), `frontend/src/components/chat/cards.js` (A/D/B approvals), package scripts/changelog and build hashes. Preserve the `subagentModel` identity/source field in live/recovered approvals and the nullable approval override; rerun the suites above after conflict resolution and regenerate assets.

The chat default is intentionally reached through the existing chat settings button’s project-settings page, not a new chat sheet. Live catalog availability/pricing and a real upstream run are not verified: configuration policy is outside Track C. The standalone legacy `test-agents-http.js` CLI-spawning suite is not run; the existing serve flow and real agent/chat/project REST handlers are tested in-process instead. No full monolithic test run or cross-track integration is claimed.
