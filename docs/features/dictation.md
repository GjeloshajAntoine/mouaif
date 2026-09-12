# Dictation

## Overview

Dictation turns speech into text using a model the user picks, and hands that
text to the app rather than sending it. It has two surfaces: a **Dictate** tab
that records, transcribes and shows an editable transcript, and a **microphone
button in the chat composer** that records and drops the transcript into the
draft. The provider credential never reaches the browser: the recording is
posted to `POST /api/ai/transcribe` and the server performs the upstream call.

## Usage

### The Dictate tab

1. Open **Dictate** in the bottom tab bar.
2. Pick a **dictation model** (a model from the active project) and, if the
   model's provider uses a different dialect, the **request shape**.
3. Tap **Record**. The timer and the level meter confirm the microphone is
   live. Recording stops on the second tap, or automatically at 2:00.
4. Tap **Transcribe**. The transcript appears in an editable field.
5. Choose what happens to it: **Copy**, **Insert in chat** (fills the newest
   chat's draft), **Send to chat** (same, labelled for a send), or **Clear**.

Optional per-run hints sit above the transcript:

- **Language** — an ISO-639-1 or BCP-47 code (`en`, `fr`, `de`), passed to the
  provider so it biases decoding instead of guessing.
- **Vocabulary hint** — names and jargon the provider should expect
  (`mouaif, MediaRecorder, SSE`). This is the OpenAI-style `prompt` field.

### The composer microphone

Inside a chat, the microphone button next to the image button records and
transcribes with the same remembered model, appending the text at the caret of
the draft. Nothing is sent: dictation produces a draft, and sending stays a
user decision. If no dictation model has been chosen yet, the button says so
and points at the Dictate tab.

### Configuring a model

Model ids are user-defined (see [model-picker.md](model-picker.md)); the
provider connection decides the credential. Any of these work:

| Provider | Model id example | Request shape used |
| --- | --- | --- |
| OpenAI, Groq, Mistral, OpenRouter, self-hosted `/v1` | `whisper-1`, `whisper-large-v3`, `voxtral-mini-latest` | OpenAI-shaped (multipart) |
| Google Gemini | `gemini-2.5-flash` | Gemini (inline audio) |

The shape is inferred: `gemini` for a Gemini provider, the OpenAI shape for
model ids that look like speech-to-text (`whisper`, `transcribe`, `voxtral`,
`parakeet`), and the OpenAI shape otherwise — it is the only shape that works
against an arbitrary base URL. A project model can override the inference and
supply per-model defaults in `.mouaif.json`:

```json
{
  "models": [
    { "id": "gemini-2.5-flash", "provider": "gemini" },
    {
      "id": "my-self-hosted-asr",
      "provider": "openai-compatible",
      "transcription": {
        "kind": "openai-compatible",
        "path": "/v1/audio/transcriptions",
        "language": "fr",
        "prompt": "mouaif, SSE, MediaRecorder"
      }
    }
  ]
}
```

`transcription: true` (or any object) also marks a model as a dictation
candidate, which matters only when the project has models the id-inference
cannot recognise.

The chosen model and request shape are remembered app-wide in the app store
under the `dictation` key, so the next session — and the composer microphone —
use the same one.

## Behavior

- **Recording is capped at 2:00** (`MAX_RECORDING_MS`) and stops itself rather
  than dropping the tail.
- **The container follows the browser.** Opus-in-WebM on Chromium, Ogg/Opus on
  Firefox, MP4/AAC on Safari; the first type the browser reports as supported
  wins, and the recorder's own `mimeType` is used afterwards.
- **Nothing is auto-sent.** The composer hand-off fills a draft; the dictate
  page fills the newest chat's draft.
- **The model list is the project's models**, filtered to the ones that can
  plausibly transcribe: explicitly marked models plus id hints, or every project
  model when nothing is recognisable. The page states how many models were
  filtered out (`total` vs the rows shown) only through its empty state.
- **Nothing is preselected when the choice is real.** With one candidate in the
  selected shape it is selected; with two, the picker asks.
- **Failures name their cause.** A rejected key surfaces the provider's own
  message with HTTP 401, an unreachable provider is 502, a stalled one is 504
  after 60s, and a recording that is too long is 413.
- **Dictation is not a security boundary or a background service.** It records
  only while the button says it is recording, and it stops the microphone on
  unmount.
- **The Dictate tab works without an active project** — it adopts the first
  registered project (and names it in the Model group's title) so the model
  picker is not empty after a cold start or a PWA launch. With no registered
  project at all, it says so and only Copy is available on a transcript.

## Implementation notes

- `src/transcribe.js` — the two request families, the response parsers, and the
  family inference. Pure: multipart bodies are built by hand (not with
  `FormData`) so the wire shape can be asserted byte-for-byte in a test.
- `src/server-handlers-transcribe.js` — `GET /api/ai/transcribe/models` and
  `POST /api/ai/transcribe`. Resolves the model through the shared
  `resolveModel`, injects the credential server-side, applies the 60s deadline,
  and maps typed codes onto HTTP statuses. Mounted before the generic
  `/api/ai/` branch in `src/http-server.js`.
- `frontend/src/dictation.js` — the browser half: recorder capability probing,
  the clock, base64 encoding, the model-selection rules (`resolveDefaultModel`),
  and the transcript action set. Pure enough to unit-test.
- `frontend/src/components/DictationPage.jsx` — the **Dictate** page
  (`#/dictation`), and `frontend/src/components/chat/MicButton.jsx` — the
  composer microphone. Both use the same helper module, so the two surfaces
  cannot disagree about the model or the request shape.
- `frontend/src/dictation.css` — the page and the microphone button. Mobile
  first: one column, a 56px primary control, ≥44px taps, `dvh` for the iOS
  keyboard, and a `prefers-reduced-motion` branch for the pulse.
- The audio body is JSON base64 (`audioBase64`), capped at ~20 MB of audio,
  so one code path owns reading the body, its size limit and its error shape.

### Tests

```bash
node scripts/test-dictation.js        # request/response shapes + helper rules
node scripts/test-dictation-http.mjs  # the real serve handlers, mock upstream
node scripts/test-dictation-page.mjs  # the page rendered against a fake API
node scripts/test-dictation-ui.mjs    # a browser fixture (prints a URL)
```

## Related

- [AI client](ai-client.md) — the chat proxy this endpoint sits beside.
- [Model picker](model-picker.md) — where the models come from.
- [App and project settings](app-and-project-settings.md) — the `dictation`
  app-level key and the project `models` array.
- [Routing](routing.md) — the `#/dictation` route.
- Source: [`src/transcribe.js`](../../src/transcribe.js),
  [`src/server-handlers-transcribe.js`](../../src/server-handlers-transcribe.js),
  [`frontend/src/dictation.js`](../../frontend/src/dictation.js),
  [`frontend/src/components/DictationPage.jsx`](../../frontend/src/components/DictationPage.jsx).
