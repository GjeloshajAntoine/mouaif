# Chat review: model request and tools

Review date: 2026-11-10. Scope: the path a chat turn takes from the composer to the provider and back.

- Server: `src/ai-stream.js`, `src/ai-endpoints.js` (builders and parsers), `src/ai-codex.js`, the request assembly in `src/server-handlers-chats.js`, history replay in `src/messages.js`, `src/shellReview.js` (model hand-off only).
- Frontend: `frontend/src/components/chat/stream.js`, `tools.js`, the tool filter in `cards.js`, `retry.js`, and the pick handler in `modelPicker.js`.

Not reviewed: `src/tools/authorization.js` internals, MCP dispatch, the `search_models` / `start_chat` app tools, `transcript.js` rendering, `live.js` beyond its event list.

How each issue was checked is stated on it:

- **Confirmed** — reproduced with a stubbed `fetch` or a direct function call.
- **Read** — follows from the code as written; not executed.
- **Expected** — depends on provider behaviour that was not tested against a live API.

The existing test suite was not run and no source file was changed.

## Fix status

Fixed on 2026-11-10 except S9, with regression checks in `scripts/test-chat-request-fixes.js` and `scripts/test-provider-request-shape.js`.

- S9 is not fixed. Stored tool rows carry no round marker, so replay cannot tell two calls of one round from two rounds that produced no text. Fixing it needs a round id on persisted tool rows. The related Anthropic point is fixed: the tool results of a live round now ride one user message.
- F4 is handled through the server: a reply that ended early gets a saved ⚠ note row (`finishNotice` in `src/server-handlers-chats.js`), sent on `done` as `notice` and drawn as an error card.
- F3: a retry posts `retry: true`; the server reuses the saved prompt when only error rows follow it, and saves a new one otherwise (the request must end on a user turn).

## Summary

| # | Area | Issue | Severity | Status |
|---|------|-------|----------|--------|
| S1 | Server | Anthropic replies capped at 1024 output tokens by default; truncation is silent | High | Confirmed |
| S2 | Server | The caller's model object is mutated; thinking levels leak between runs | High | Confirmed / Read |
| S3 | Server | Anthropic thinking: `budget_tokens` on models that reject it; thinking blocks not replayed in tool rounds | High | Expected |
| S4 | Server | Persisted error rows are replayed to the model as `system` messages | High | Confirmed |
| F1 | Frontend | A refused call to a disabled tool re-enables that tool in the chat's filter | High | Read |
| F2 | Frontend | A model error ends with the status "reconnected" (success) | Medium | Read |
| F3 | Frontend | Retry saves the prompt a second time | Medium | Read |
| F4 | Frontend | `finish` is never handled, so truncation is never shown | Medium | Read |
| S5 | Server | Idle watchdog resets on parsed events, not bytes | Medium | Read |
| S6 | Server | Tool-call deltas without `index` merge into one call | Low | Read |
| S7 | Server | Subagent system prompt goes to OpenAI-shaped providers as a block array with `cache_control` | Low | Expected |
| S8 | Server | `runSingleToolCall` early exits return the wrong shape | Low | Read |
| S9 | Server | History replay splits a multi-call round into one assistant message per call | Low | Read |
| F5 | Frontend | 409 path calls `setImageAttachments` without a guard | Low | Read |
| F6 | Frontend | A stream that closes without `done` or `error` is treated as a finished turn | Low | Read |
| F7 | Frontend | `parseToolArgs` accepts non-object JSON and silently cuts input at 2048 chars | Low | Read |
| F8 | Frontend | `usage_output` is summed, but Anthropic's counts are cumulative | Low | Read |
| F9 | Frontend | Top-level `image` events are not drawn live | Low | Read |
| F10 | Frontend | Thinking level is kept when the model changes | Low | Not checked further |

## Server

### S1. Anthropic replies are capped at 1024 output tokens by default, and truncation is silent

- `src/ai-endpoints.js:1624` sends `max_tokens: maxOutputNum || 1024`. A chat's `maxOutputTokens` defaults to `''` (`src/chats.js:108`), so every Anthropic chat that has not set a cap gets 1024.
- With a thinking level the cap becomes budget + 256 (`src/ai-endpoints.js:1671`), which leaves 256 tokens for the answer and tool arguments. The probe produced `max_tokens: 2304` for level "low".
- `parseAnthropicSSE` never reads `stop_reason` (`message_delta` at `src/ai-endpoints.js:2058`), so `max_tokens`, `refusal` and `pause_turn` produce no event. The probe's truncated reply returned `ok: true` with events `usage_input, message, usage_output, done`.
- A tool call cut off mid-arguments has invalid JSON. It is dispatched with `{ __raw: … }` (`src/ai-stream.js:171`) and replayed to Anthropic as `input: {}` (`src/ai-endpoints.js:1479`).

Suggested fix: default to a much larger cap (Anthropic's guidance for streaming is around 64000, bounded by the model's limit), emit `finish` from `stop_reason`, and refuse to dispatch tool calls from a round that ended on `max_tokens`.

### S2. The caller's model object is mutated, so thinking levels leak between runs

- `src/ai-stream.js:791-797` writes `thinkingLevel`, `maxOutputTokens` and `noTools` onto the `model` it was given. `noTools` is never read by any builder.
- A subagent that inherits the chat model uses the same object: `let nestedModel = model` at `src/ai-stream.js:2135`, replaced only when the source is not `'chat model'` (line 2201). Lines 2253-2256 then set or delete `thinkingLevel` on it. After such a delegation the parent's remaining rounds run at the subagent's level, and parallel subagents overwrite each other.
- The shell reviewer returns the chat's own model object when it has `auth` set (`src/shellReview.js:155`) and passes its configured `thinkingLevel` to `streamChat`, so a review changes the chat's level too.

Confirmed for the side-call case: after `streamChat({ model, thinkingLevel: 'low', noTools: true })`, the next plain request on the same object carried `thinking: { type: 'enabled', budget_tokens: 2048 }`. The subagent path is from reading.

Suggested fix: shallow-copy the model at the top of `streamChatInScope` and where `nestedModel` is first assigned.

### S3. Anthropic thinking breaks on newer models and probably on tool rounds

- `buildAnthropicRequest` always sends `thinking: { type: 'enabled', budget_tokens }` (`src/ai-endpoints.js:1670`). Current Anthropic documentation says this returns a 400 on Sonnet 5, Opus 4.7 and later, which take `{ type: 'adaptive' }` plus `output_config.effort`. `claude-sonnet-5` is in `ANTHROPIC_MODEL_CATALOG` (`src/ai-endpoints.js:462`).
- Thinking blocks and their signatures are discarded: `signature_delta` is ignored at `src/ai-endpoints.js:2036` and `openAIMessageToAnthropic` only emits text and `tool_use` blocks. The follow-up request after a tool call therefore replays `tool_use` without the thinking block that preceded it. The API expects those blocks passed back unchanged; a 400 on the second round with thinking on is the expected result. Not confirmed against the live API.
- The same loss applies to other providers that need reasoning state echoed during tool rounds (DeepSeek's reasoner, Gemini thought signatures through OpenRouter). Lower confidence; not tested.

### S4. Persisted error rows are replayed to the model as `system` messages

- A failed turn is stored as `role: 'system'` with content like `⚠ EUPSTREAM: Upstream 400 …` (`persistStreamError`, `src/server-handlers-chats.js:1541`).
- `reconstructUpstreamHistory` pushes every non-tool row with its stored role (`src/messages.js:349-353`). Nothing filters error rows.

Confirmed: `reconstructUpstreamHistory([user 'hi', system '⚠ EUPSTREAM…', user 'hi'])` returns all three rows unchanged.

Effects on every later turn of that chat:

- The model receives the error text with system authority.
- On Anthropic, all system messages are merged into the cached system block (`src/ai-endpoints.js:1594`), so the block changes and the prompt cache is invalidated from that point.
- Combined with F3, the model sees the same user prompt twice with the error between.

Suggested fix: mark error rows (a `kind` or the `e` client-id prefix) and skip them in replay.

### S5. Idle watchdog resets on parsed events, not bytes

- `resetIdle()` runs once per parsed SSE event (`src/ai-stream.js:1373-1374`). The comment at line 1267 says every streamed byte.
- SSE comment lines are dropped in `parseSSEFrame` (`src/ai-stream.js:64`, 74), so gateway keep-alives such as OpenRouter's processing comments never reset the timer.
- A model that reasons without streaming for more than 3 minutes (`UPSTREAM_IDLE_MS`, line 1271) is cancelled with `ETIMEOUT` even though the connection is alive.
- The one-shot JSON image path (line 1364) has no reset at all, so image generation has a hard 3-minute limit.

### S6. Tool-call deltas without `index` merge into one call

`src/ai-stream.js:1560` uses index 0 when a delta has no numeric `index`. A gateway that omits it for parallel calls produces one call whose name is the last one seen and whose arguments are every call's JSON concatenated.

### S7. Subagent system prompt is a block array with `cache_control`

`src/ai-stream.js:2183` and 2193 build the subagent's system message as `[{ type: 'text', text, cache_control }]`. Anthropic, Gemini, Ollama and Codex builders flatten it; `buildOpenAIRequest` sends it verbatim to every OpenAI-shaped provider. Strict providers may reject an array system content or the unknown `cache_control` field. Not tested.

### S8. `runSingleToolCall` early exits return the wrong shape

Three exits return `exec` instead of `{ exec, imageParts }`: `src/ai-stream.js:319` (ELOOP), 506 (invalid `hook_create`), 577 (invalid `ask_user`). The tool loop ignores the return value, so nothing breaks there. The direct-call wrapper at lines 159-164 reads `out.exec`, finds nothing, and reports a generic `ESUBAGENT: Tool dispatch failed`. The only direct caller dispatches `subagent`, so this is probably unreachable today.

### S9. History replay splits a multi-call round

The live loop sends one assistant message with N `tool_calls`. Replay emits one assistant message per call (`src/messages.js:328-332`). The comment at line 320 says the replayed prefix matches the live one; for rounds with more than one call it does not, which costs prompt-cache hits on resumed chats. Related: Anthropic tool results are sent as one user message per result; its documentation recommends all results of a round in a single user message.

## Frontend

### F1. A refused call to a disabled tool re-enables that tool

- The server refuses a call to a tool that is unchecked in the chat's filter with `ETOOL_DISABLED`, and still emits `tool_call` followed by `tool_result` (`src/ai-stream.js:220-227`).
- The client calls `markToolUsed` on every top-level `tool_call` (`frontend/src/components/chat/stream.js:1504`). When the filter is an explicit array that lacks the tool, it calls `state._toggleTool(name, true)` (lines 124-126), which persists through the normal toggle path (`cards.js:631`).

Result: the model calls a tool the user switched off, the server refuses once, the client switches the tool back on, and the next turn advertises and allows it. The filter is captured once per turn on the server, so the current turn stays protected.

Suggested fix: move the auto-check to `tool_result` and require `ok`, or at least skip results with `code: 'ETOOL_DISABLED'`. Consider dropping the auto-check entirely: the server never runs a filtered tool, so the "model clearly has it" premise in the comment no longer holds.

### F2. A model error ends with the status "reconnected"

- The `error` branch sets `streamFailed = true` (`stream.js:1535`), the same flag a dropped socket sets.
- After the loop, `streamFailed` discards the live segment and starts stream recovery (lines 1622-1629): status "connection lost — reconnecting…".
- The next poll sees the run is no longer running and calls `finishRecovery(state, refs, null, false)` (line 1717), which sets "reconnected" with the success colour (line 1740).

The error card stays in the transcript, but the status pill reports a connection problem that did not happen and then success.

Suggested fix: use a separate flag for a server-reported error; sync once from disk and leave the error status in place.

### F3. Retry saves the prompt a second time

`retryFailedTurn` calls `send` with `retry: true`, which posts the same content to `/messages/stream` again. After a mid-stream `error` the first user row is already saved, and the server's duplicate-clientId guard (`src/chatdb.js:794-802`) gives the second copy a fresh id rather than replacing the first. Each retry therefore adds another copy of the prompt to the transcript and to the history sent upstream (see S4 for what sits between the copies). The comment at `stream.js:914-916` describes the saved row replacing the bubble; that only holds when the first attempt was never saved.

### F4. `finish` is never handled

The server forwards non-tool finish reasons as `finish` (`src/ai-stream.js:1552`). No frontend file handles that event name, in `stream.js` or `live.js`. A reply cut by `length`, `content_filter` or Gemini's `MAX_TOKENS` / `SAFETY` looks like a normal completion. Together with S1 this hides every truncation.

### F5. Unguarded `setImageAttachments` on the 409 path

`stream.js:1160` calls `setImageAttachments(localAtts)` directly; other uses are guarded (`if (setImageAttachments)` at line 1063). Retry payloads rebuilt from a persisted error row carry only `content` and `attachments` (`retry.js:20-23`). On a retry the 409 branch returns early at line 1138 unless the code is `EHOOK_BLOCKED`, so the crash needs a retry that a `prompt.submit` hook blocks. When it happens, the lines that clear `state.streaming` do not run and the composer stays locked.

### F6. A stream that closes without `done` or `error` is treated as finished

When the reader reports `done` with no `done` or `error` frame (server restart, proxy cut that closes cleanly), `send` falls through to the normal completion path (`stream.js:1631` onward): the partial text is finalized and the status becomes "done". The later sync corrects the transcript, but nothing tells the user the turn was interrupted. Tracking whether a `done` frame arrived and starting recovery otherwise would cover it.

### F7. `parseToolArgs` edge cases

- `JSON.parse` output is returned whatever its type (`tools.js:118`). `@mcp__srv__tool 42` or `"text"` or `[1]` is sent as the tool's `args`; falsy JSON (`0`, `false`, `null`) falls through to the model instead.
- The key=value walker reads at most 2048 characters (`tools.js:128`) and returns what it parsed, so longer input is cut without a message.

### F8. `usage_output` is summed

`stream.js:1396-1397` adds each `usage_output` to the running totals. The server comment at `src/ai-stream.js:1524` notes Anthropic's `message_delta` output counts are cumulative. More than one `message_delta` in a round over-counts the live figure until `done` replaces it. Display only.

### F9. Top-level `image` events are not drawn live

The server emits `image` for generated pictures (`src/ai-stream.js:1440`). `handleStreamEvent` has no `image` branch; only the nested subagent path draws them (`transcript.js:1635`). A picture generated by the chat's own model appears after the end-of-turn sync.

### F10. Thinking level is kept when the model changes

`onPickerPick` (`modelPicker.js:732-741`) updates only `providerId` and `modelId`. The chat's `thinkingLevel` is sent as-is with the next request. A value that is valid for one provider can be wrong for the next: OpenAI-shaped builders pass it verbatim as `reasoning_effort`, while the Anthropic builder silently ignores anything that is not `low`/`medium`/`high` or a number. I did not check whether another module reconciles the level against the new model's `thinking.levels`.

## Suggested order

1. S1 and F4 together: raise the Anthropic default and surface truncation.
2. S2: copy the model object. Two small edits.
3. S4 and F3: stop replaying error rows; decide whether retry should reuse the saved prompt.
4. F1: stop the client from re-enabling refused tools.
5. S3: adaptive thinking for current Anthropic models, and thinking-block replay in tool rounds. This is the largest change.
6. F2, S5, then the low-severity items.
