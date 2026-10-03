# Chat model tools

## Overview

The assistant can search saved project models and configured providers’ live chat catalogs, choose a model for a chat, and start an AI response in that chat. These are native tools in the **Chats** family, using the same selection and Off / Ask / Allow controls as other chat tools.

## Usage

Ask in a normal sentence:

```text
Find the available Gemini models, create a chat using one, and start it with “Review the project’s tests”.
Switch this chat to the saved model called beta for the next turn.
```

The model can follow this sequence:

1. Call `search_models` with an optional `query` and `providerId`.
2. Pass a returned `providerId` / `modelId` pair to `create_chat`, or call `update_chat` with an existing `chatId` and that pair.
3. Call `start_chat` with the target `chatId` and non-empty `content` to send the prompt immediately.
4. Open the returned `#/chat/<id>` link to follow the response, or call `get_chat` with `includeMessages: true` to read persisted messages.

Example arguments (each block is a separate tool call):

```json
{ "query": "gemini", "providerId": "openrouter", "limit": 20 }
```

```json
{ "title": "Test review", "providerId": "openrouter", "modelId": "google/gemini-2.5-pro" }
```

```json
{ "chatId": "<created-chat-id>", "content": "Review the project’s tests." }
```

Use actual model identities from the search results; example availability depends on the provider.

### Search options

- `query` matches model ids and labels case-insensitively; omit it to list models.
- `providerId` restricts the search to one provider connection.
- `includeLive` defaults to `true`. Set it to `false` to search only saved project models without contacting providers.
- `limit` defaults to 20 and accepts 1–100. Pass a numeric `nextOffset` back as `offset` for another page; `null` means the end.
- Results include `providerId`, `modelId`, `label`, and `source` (`project` or `live`). Exact provider/model pairs are deduplicated, with saved project records preferred.
- A failed live provider is reported in `failures`; other providers and saved models still contribute results. Credentials and hydrated connections are never returned.

### Choosing and starting

`create_chat` still creates a chat without sending anything; its `topic` is only a draft. `update_chat` changes the selected model for the **next** turn, not an already-running response. Saved models can infer their provider; live model selections need both identity fields.

`start_chat` targets an existing chat with a selected model. It sends the supplied `content` (up to 200,000 characters), not the composer draft or draft images. The tool returns after the prompt is stored and the background turn starts; it does not wait for the answer. Starting a busy chat returns `EALREADY_RUNNING` without appending another prompt. A missing chat returns `ENOTFOUND`; empty content or a missing model returns `EBADINPUT`.

Enable/select `search_models`, `create_chat`, `update_chat`, and `start_chat` as needed in the chat’s Tools card or **Settings → Project → Tools → Chats**. Each function uses the ordinary authorization gate. Starting a chat does not grant the target chat any extra tool permissions; its own settings and approvals apply.

## Response behavior

Background turns use normal transcript persistence, live replay, busy state, cancellation, usage accounting, and authorization. Later provider failures are saved in the target transcript. Successful starts refresh the project chat list without navigating away from the current chat. Live searches reuse the provider catalog cache; provider requests have a bounded timeout.
