# Subagent image generation

## Overview

An agent pinned to an image model can generate artwork natively through OpenRouter or Gemini. Generated pixels appear in its nested transcript and return to the parent assistant as vision content, rather than disappearing into an empty successful response.

## Usage

1. Connect an OpenRouter or Gemini provider in Settings → Providers.
2. In Settings → Project → Agents, pin an agent to an image model and write its drawing instructions.
3. Approve a `subagent` delegation to that agent, or send an `@` command:

```text
@Artist Draw a simple blue bird icon on a white background.
```

Tap the resulting image to enlarge it. Direct `@agent` image results persist as a subagent tool card and an assistant billing row, so the artwork remains after reload. Generating an image does not attach it to the composer draft or start another chat turn. Normal subagent authorization still applies.

## Behavior

- OpenRouter's dedicated image catalog (`/images/models`) resolves to `POST /images` with a prompt, `n: 1`, and a non-streaming JSON response. The parser accepts `data[].b64_json` and `media_type`, and preserves `usage.cost` for billing. Catalog data can supply selection metadata only; it cannot replace the app connection's URL or credentials.
- OpenRouter image-capable chat models use `/chat/completions` with `modalities`, and parse inline `images[].image_url.url` from streamed deltas or message objects.
- Gemini Imagen uses `:predict` with one instance and `sampleCount: 1`. Gemini image chat models use `streamGenerateContent` with `responseModalities: ["TEXT", "IMAGE"]`, and parse `inlineData` (or `inline_data`). Thinking-image parts are not exposed as artwork.
- Dedicated image calls do not advertise tools. They retain the chat loop's abort signal, idle timeout, error handling, and per-round usage accounting.
- The normalized `image` event carries `{ type, data, mimeType }`. A delegated assistant turn stores its image blocks in `images`; the subagent result also carries them in `content` for parent vision feedback. Base64 is omitted from the textual tool feedback.
- Each generated image must be inline PNG, JPEG, WebP, or GIF and at most 12 MiB of encoded data; at most eight images are accepted per run. Remote output URLs are rejected rather than fetched with provider credentials. Image-only calls returning no pixels fail with `ENO_IMAGE` instead of claiming success.
- This first native path is text-to-image. Models requiring image references are rejected with `EBADINPUT`; reference-image editing and asynchronous/long-running prediction APIs are not implemented.

## Verification

```bash
node scripts/test-subagent-images.js
npm run test:subagent-prompt
node scripts/test-read-image-preview.js
```

The generation tests use mocked providers, not paid upstream calls.
