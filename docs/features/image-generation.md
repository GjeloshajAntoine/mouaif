# Image generation

## Overview

`image_gen` lets the assistant draw a picture with an image model, **save it as a file inside the project**, and receive the picture back as an image part. That last part is what makes it work between agents: a subagent can generate artwork, and the main agent gets both the file path *and* the pixels in the very tool result the delegation returns — so the main agent can look at the image, embed it in a page, or hand the path to another tool. The provider credential never leaves the server; the browser posts a prompt and gets a data URL back.

## Usage

Enable the tool for the project in **Settings → Project → Image generation**, pick an image model, and ask for a picture:

```text
generate a hero image for the landing page: a red fox in falling snow, soft morning light
```

The model calls:

```json
{
  "prompt": "a red fox in falling snow, soft morning light, shallow depth of field",
  "size": "1024x1024"
}
```

and receives a small three-line header plus the picture:

```text
# Generated 1 image with gpt-image-1 (openai-compatible)
# File: generated/a-red-fox-in-falling-snow-2026-09-16_09-41-02.png (image/png, 1843200 bytes)
# The picture is attached to this tool result as an image part.
```

### Arguments

| Argument | Purpose |
| --- | --- |
| `prompt` | **Required.** What to draw. |
| `model` / `provider` | Pick a specific image model. Defaults to the project's configured one (Settings → Project → Image generation). |
| `path` | Where to save it, project-relative. A directory is allowed (a name is generated inside it); a name with no extension gets the MIME-derived one (`.png`, `.jpg`, `.webp`, …). |
| `size` | `WIDTHxHEIGHT`, e.g. `1024x1024`. Ignored by providers that do not take one. |
| `aspectRatio` | Imagen-style `16:9`. |
| `n` | 1–4 pictures. Every picture is saved as its own file (`-2`, `-3`, …). |

With no `path`, generated pictures land in `generated/<prompt-slug>-<timestamp>.<ext>` at the project root, so the files are part of the project and of its git history rather than hidden state.

### What the user sees

The tool card paints every generated picture as a thumbnail with its saved path and size underneath. Tap a thumbnail for the full-screen viewer (the same one `read_file` images use); tap outside it, tap **✕**, or press `Escape` to close. A picture generated **without** a save (the Settings page preview) says `Not saved to the project` instead of showing a path that does not exist.

### The main agent receiving a subagent's picture

Because a subagent runs the same tool surface as its parent, a delegated run can generate an image directly. Two properties make that useful:

- the tool result the subagent returns carries the file path, so the main agent can `read_file` it, embed it, or move it;
- the picture travels as an image part, so the main agent — on a vision model — actually sees what the subagent drew, and the chat paints it inside the delegated card.

## How a request is shaped

A generated image is a *different product* from a chat completion, so image generation has its own request builders next to dictation's ([src/imagegen.js](../../src/imagegen.js), the same structure as [src/transcribe.js](../../src/transcribe.js)). Four families ship:

| Family | Request | Typical endpoint |
| --- | --- | --- |
| `openai-image` | `POST {base}/images/generations` with `n`, `size`, `response_format: b64_json` | OpenAI, self-hosted OpenAI-shaped servers |
| `openai-chat-image` | `POST {base}/chat/completions` with `modalities: ["image","text"]` | OpenRouter's image models, image-capable chat models |
| `gemini` | `POST {base}/v1beta/models/{model}:generateContent` with `responseModalities: ["TEXT","IMAGE"]` | Google's `*-image` models |
| `gemini-predict` | `POST {base}/v1beta/models/{model}:predict` with `instances` / `parameters` | Imagen |

The family is chosen in strict precedence: an explicit `imageGeneration.kind` on the model (the escape hatch), then the model id (`dall-e-*`, `gpt-image-*` → the images endpoint; `imagen-*` → `:predict`; a Gemini connection → `generateContent`), then the connection. An **OpenRouter** model always uses the chat route, because OpenRouter has no `generateContent` endpoint at all — `openrouter.ai/api/v1/v1beta/...` is a URL that cannot exist.

The default for an unrecognised OpenAI-shaped model is the chat route, deliberately: that is where OpenRouter files its image models, and guessing `/images/generations` for a model with no entry there is a `400` the user cannot act on. The response parser accepts every shape providers actually return, so a family guess that is *close* still works:

```text
{ data: [{ b64_json }] }                                     → OpenAI images
{ choices: [{ message: { images: [{ image_url: { url } }] } }] } → OpenRouter chat
{ choices: [{ message: { images: [{ type, data }] } }] }      → native block
{ candidates: [{ content: { parts: [{ inlineData }] } }] }     → Gemini
{ predictions: [{ bytesBase64Encoded }] }                      → Imagen
```

## Settings

**Settings → Project → Image generation** holds two things:

- an **Off / Ask / Allow** authorization segment, **off by default** — this is the one tool that spends money outside a text model and writes files into the project, so a project opts in explicitly. The default itself lives in the authorization module (`DEFAULT_OFF_TOOLS` in [src/tools/authorization.js](../../src/tools/authorization.js)), so an unconfigured project reports `off` rather than `ask`; storing any mode overrides it;
- an **image model** picker. The list is the project's own model records plus the connected providers' live catalogs, filtered to models that plausibly generate pictures (a provider-reported `image` output modality, a recognised id, or a user mark). The choice is stored in `.mouaif.json` next to the other project settings, because a picture is project content:

```json
{
  "imageGeneration": { "modelId": "gpt-image-1", "providerId": "openai-compatible" },
  "tools": { "image_gen": { "mode": "ask" } }
}
```

A model can override its own family and defaults:

```json
{
  "id": "my-diffusion",
  "provider": "openai-compatible",
  "imageGeneration": { "kind": "openai-image", "size": "1024x1024" }
}
```

## REST surface

| Route | Purpose |
| --- | --- |
| `GET /api/ai/image/models?projectDir=<abs>[&provider=<id>][&_bust=1]` | The models this project can draw with, each with its request family, plus `kinds` and the configured selection. |
| `POST /api/ai/image` | `{ projectDir, prompt, modelId?, providerId?, n?, size?, aspectRatio?, save?, path? }` → `{ ok, images: [{ relPath, mimeType, bytes, dataUrl }], model, kind, usage, cost }`. |

Both are proxies, for the same reason the chat endpoint is one ([decisions §10](../decisions.md)): the browser holds no provider credential. `POST /api/ai/image` generates without saving unless `save: true`, which is what the model tool always does.

## Implementation notes

- **One runner, two callers.** [src/tools/image.js](../../src/tools/image.js) owns model resolution, the request, the file write, and the result shape. The `image_gen` dispatch branch in [src/ai-stream.js](../../src/ai-stream.js) and `POST /api/ai/image` both call `runImageTool`, so the model-driven picture and the Settings-page picture cannot drift apart. `save: false` is the only difference: the REST preview keeps the bytes in memory.
- **The image block is the existing one.** A generated picture is returned as `{ type: 'image', data, mimeType }` inside `result.content` — the same shape `read_file`'s image path and MCP image results use. `toolResultImageParts` in [src/ai-stream.js](../../src/ai-stream.js) therefore forwards it as a native vision part with no provider-specific code, and `openAIContentToAnthropic` / `openAIContentToGeminiParts` convert the same block for Anthropic and Gemini. That is also why a subagent's generation reaches the main agent: the nested dispatcher returns the same result object.
- **The model never pays for base64 twice.** `compactToolFeedback` in [src/toolFeedback.js](../../src/toolFeedback.js) has an `image_gen` branch that replaces the whole result with `{ ok, model, images: [{ relPath, mimeType, bytes }], note }`, and `omitImagePayloads` replaces any image `data` with `[image payload omitted; attached separately]` in reconstructed history. The pixels ride exactly one vision message.
- **Path safety reuses the file tools'. ** `outputPathFor` resolves through `resolveSandbox`, and `saveImage` refuses anything whose relative path escapes the project root (`EOUTSIDE_PROJECT`), so a model-supplied `path` cannot write outside the project.
- **Caps.** `n` is clamped to 4, a prompt over 8 KB and a picture over 8 MB are refused with `ETOOL_CAP` / `ETOOLARGE`. The per-picture cap is deliberately below what a transcript can carry comfortably and *above* `read_file`'s own 4 MB image cap would be wrong the other way — a generated file the agent could not read back would be worse than a typed error.
- **Authorization** rides the same gate as every other native tool. `image_gen` is in `NATIVE_TOOLS` and in `DEFAULT_OFF_TOOLS` ([src/tools/authorization.js](../../src/tools/authorization.js)), so an `off` project never advertises the tool (the spec is dropped from the request, costing zero prompt tokens) and the chat's Tools card / popup carry an Off/Ask/Allow segment for it (a chat override wins over the project).
- **The model tool always saves.** A tool call is scaffolding for project work, so its result must be durable: `runImageTool` writes every picture unless the caller passes `save: false`, which only the REST preview path does.
- **Cost.** The run is priced with `src/usage.js` when the provider reports usage on its response. Most image endpoints bill per picture and report nothing, which is why a run with no usage stays `known: false` (rendered `--`) rather than `$0.00` — the app's existing convention ([decisions §14](../decisions.md)).
- **Frontend.** [frontend/src/imageGeneration.js](../../frontend/src/imageGeneration.js) holds the pure helpers (load models, generate, read image blocks out of a result, data URL, kind label). The card renderer is `renderImageGenToolResult` in [frontend/src/components/chat/toolRender.js](../../frontend/src/components/chat/toolRender.js); a result that reached the UI as plain text (a replayed row) says `Image bytes are not part of this result.` instead of painting an empty frame.
- **Mobile-first.** The thumbnail is capped at 220 px by the existing `.tool-card__image` rule, the lightbox is `position: fixed; inset: 0` with `object-fit: contain` so a wide picture fits a 360 px viewport, each thumbnail is wrapped in a button (≥ 44 px tap target), and the settings group stacks its picker under the segments in one column.
- **Tests.** [scripts/test-image-generation.js](../../scripts/test-image-generation.js) covers family routing, every request shape, every response shape, the file write (byte fidelity, no-overwrite indexing, MIME-derived extension), a path-escape refusal, the non-saving run, the spec advertising the project's models, tool-feedback compaction, and the REST surface — with a local stub provider so the real fetch/parse/write path runs.

## Related

- Opening images the model reads: [read-file-images.md](./read-file-images.md).
- Delegated runs and their cards: [subagent-transcript.md](./subagent-transcript.md), [agents.md](./agents.md).
- Tool authorization: [tool-authorization.md](./tool-authorization.md).
- The same per-product split for audio: [dictation.md](./dictation.md).
