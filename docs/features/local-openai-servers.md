# Local OpenAI-compatible servers (llama.cpp, LM Studio)

## Overview

The **OpenAI compatible** provider connects mouaif to any OpenAI-shaped HTTP endpoint. Two of the most common are local inference servers you run yourself: **llama.cpp**'s `llama-server` (default `http://127.0.0.1:8080/v1`) and **LM Studio** (`http://127.0.0.1:1234/v1`). Neither requires an API key, so an OpenAI-compatible connection may now be saved with a **blank key** and a custom base URL. When no key is stored, mouaif sends **no `Authorization` header** — a local server that runs unauthenticated accepts the request, and a hosted endpoint that really needs a key still fails cleanly with a `401` you can act on.

## Usage

### Point a connection at llama.cpp

1. Start llama.cpp's server (the OpenAI-compatible surface lives under `/v1`):

   ```bash
   llama-server -m ./model.gguf --port 8080
   ```

2. In mouaif, open **Settings → Providers → + Add provider**.
3. Choose **OpenAI compatible**.
4. Set **API base URL** to the server's `/v1` root — for llama.cpp that is `http://127.0.0.1:8080/v1`.
5. Leave the **provider API key** field **empty**.
6. **Save provider.** A blank key on a key-optional provider is accepted; the row shows `no key`.
7. In the project's **Models** editor add a model whose `provider` is `openai-compatible` and whose `id` is the served model name, then use the model picker's refresh (↻) to list the server's models live.

```jsonc
// <projectDir>/.mouaif.json
{
  "models": [
    { "id": "local-model", "provider": "openai-compatible", "label": "llama.cpp (local)" }
  ]
}
```

### LM Studio

Identical flow with the base URL `http://127.0.0.1:1234/v1` and the LM Studio model identifier as `id`. LM Studio does not require a key either.

### Hosted OpenAI-shaped endpoints

Hosted providers (OpenAI, Together, Groq, and the first-class Azure/Mistral/DeepSeek connections) still require a key. The Settings form refuses to save an OpenAI-compatible connection with a blank key **only** when the chosen provider is not key-optional; for `openai-compatible` you may leave it blank, but a hosted base URL without a key will return a `401` from upstream.

## Behavior

- **Key is optional for `openai-compatible`.** The provider carries `keyOptional: true`. `requireApiKey` accepts a model with no `apiKey`, and `buildOpenAIRequest` omits the auth header entirely instead of emitting `Authorization: Bearer undefined`.
- **The base URL is a live-list input.** The model-list refresh reads the connection's configured base URL, so a connection pointed at a local server lists that server's models rather than the hosted `api.openai.com` default. Trailing slashes are normalized before `/models` is appended.
- **The list cache is base-URL aware.** The `/api/ai/models/live` cache key includes the base URL, so switching a keyless connection between two local servers (llama.cpp `:8080` vs LM Studio `:1234`) cannot serve the previous server's catalog.
- **Errors are still typed.** A local server that is not running throws `EUNREACHABLE`, which the live route maps to `503` and the picker renders as "not running". A hosted endpoint that returns `401` on a keyless list is still surfaced as a typed error.
- **Not Ollama.** Ollama keeps its own provider and native `/api/chat` shape (see [ai-client.md](./ai-client.md)); use this provider only for the OpenAI-compatible `/v1` surface, which Ollama also exposes if you prefer that shape.

## Related

- [docs/features/ai-client.md](./ai-client.md) — the proxy architecture every provider rides on.
- [docs/features/cloud-providers.md](./cloud-providers.md) — the other OpenAI-shaped providers.
- [AI providers](./providers.md) — where provider credentials are stored.
