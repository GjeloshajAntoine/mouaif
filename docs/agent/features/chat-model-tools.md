# Chat model tools implementation

## Overview

`search_models` and `start_chat` extend the native Chats family. Existing `create_chat` and `update_chat` handle model selection; model changes affect subsequent turns.

## Usage

Run `npm run test:mouaif-tool` for catalog, authorization, model selection, background-turn, and HTTP SSE parity coverage. Run `npm run test:chat-model-tools-ui` for shared tool-tree visibility and viewport fit at 360, 390, and 430 px with an isolated browser fixture.

## Implementation notes

- Metadata and schemas live in `src/tools/appToolNames.js` and `src/tools/mouaif.js`; the normal native tool registry, permission resolver, and prompt allowlists consume that metadata.
- Search reuses `src/modelList.js` and its credential/base-URL-aware, hour-long cache and bounded timeout. Exact provider/model identities deduplicate with saved records first. Returned rows explicitly select public identity fields, never hydrated connections.
- `startChatTurn` in `src/server-handlers-chats.js` invokes the same body-based runner as `POST /api/chats/:id/messages/stream`, using a response sink that discards HTTP output. It resolves at successful SSE setup or returns typed setup errors. Later failures use the normal transcript path.
- Background turns retain the target chat’s busy state, cancellation controller, live replay, prompt presets, tool filter, authorization, transcript and usage persistence. No new REST route or server lifecycle command is used.
- `frontend/src/toolGroups.js` adds both tools under Chats. Successful starts refresh the project chat list through `frontend/src/components/chat/meta.js`; they never navigate the host away.
- Updating to a different saved model without `providerId` infers the new model’s provider rather than accidentally retaining the old provider. Live selections still require both fields.
