# Dictation

## Overview

Dictation turns speech into text using a model the user picks, and hands that
text to the app rather than sending it. It has two surfaces: a **Dictation**
page under Settings that records, transcribes and shows an editable
transcript, and a **microphone button in the chat composer** that records and
drops the transcript into the draft. The provider credential never reaches the
browser: the recording is posted to `POST /api/ai/transcribe` and the server
performs the upstream call.

## Usage

### The Dictation page

1. Open **Settings → App defaults → Dictation** (or `#/settings/dictation`).
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
and points at **Settings → App defaults → Dictation**.

### Configuring a model

The **Dictation** page lists two kinds of model, and you do not have to
configure anything for the first one:

1. **Models from your providers.** Every connected provider in Settings →
   Providers is asked for its current catalog, and the entries that can
   transcribe are listed. `Refresh` re-reads them (the list is cached
   server-side for an hour). This is what makes a fresh install work with no
   setup: connect a Gemini key and `gemini-2.5-flash` is offered.
2. **Models from the project.** A model id in `.mouaif.json` is the way to
   describe something the provider's catalog cannot: a self-hosted endpoint, a
   per-model language default, or a specific OpenRouter slug. A project record
   for an id wins over the live entry for the same id.

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

Four signals decide whether a model is offered, and the request shape follows
from the first of them that applies:

| Signal | Example | Shape |
| --- | --- | --- |
| `transcription` is set | `"transcription": { "kind": "gemini" }` | as declared |
| the provider is Gemini, or the id is `google/…` | `gemini-2.5-flash` | Gemini |
| the id looks like speech-to-text | `whisper-1`, `mistralai/voxtral-…`, `parakeet` | OpenAI-shaped |
| the provider reports audio input | `openai/gpt-audio`, `meta/muse-spark-1.3` | OpenAI-shaped |
| nothing matches | — | OpenAI-shaped |

The last two matter on OpenRouter, which carries **no `whisper-*` at all**: its
transcribable models are ones whose names say nothing (`openai/gpt-audio`,
`mistralai/voxtral-small-24b-2507`, `meta/muse-spark`, `nvidia/nemotron-…-omni`).
It advertises each model's input modalities, so the catalog selects on that
capability instead of guessing from the name, and the picker labels such a row
`from provider · audio in`.

A project with no recognisable models is offered all of them rather than none,
because a self-hosted `my-asr` is exactly the case nothing can infer. Note that
"is this a Gemini model" is decided by the **provider** and the `google/` slug
prefix — never by a substring of the id; see the test note below.

`Request shape` overrides the inference per run: tap **Gemini** for a model that
would otherwise be sent as multipart, or the reverse. The shape follows the
selected model until you touch the control, after which your choice wins and is
remembered along with the model.

| Provider | Model id example | Request shape used |
| --- | --- | --- |
| OpenAI, Groq, Mistral, OpenRouter, self-hosted `/v1` | `whisper-1`, `whisper-large-v3`, `voxtral-mini-latest` | OpenAI-shaped (multipart) |
| Google Gemini | `gemini-2.5-flash` | Gemini (inline audio) |

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
- **The model list is the union of two sources**: the project's `models`
  (filtered to the ones that can plausibly transcribe) and the connected
  providers' live catalogs (filtered the same way, and labelled as coming from
  the provider). A project record for an id wins over the live row for it.
- **A model is classed as Gemini only when it really is one** (its provider, or
  a `google/…` slug). Classifying by id substring looked harmless and was not:
  it swept up dozens of OpenRouter entries whose names merely contain
  "gemini", which both sent them to the wrong endpoint and — because the Gemini
  family is on the candidate list by definition — filtered every other
  provider's models out of the list, so dictation appeared to offer Google
  models only.
- **One unreachable provider does not empty the list.** Its failure is reported
  with the provider's own message, and the rows from the providers that did
  answer are still offered.
- **Nothing is preselected when the choice is real.** With one candidate in the
  selected shape it is selected; with two, the picker asks.
- **The request shape follows the models**, not the order of the family list:
  in a project whose only dictation models are Gemini, the control starts on
  Gemini even if the project's first model is OpenAI-shaped.
- **Failures name their cause.** A rejected key surfaces the provider's own
  message with HTTP 401, an unreachable provider is 502, a stalled one is 504
  after 60s, and a recording that is too long is 413.
- **Dictation is not a security boundary or a background service.** It records
  only while the button says it is recording, and it stops the microphone on
  unmount.
- **The Dictation page works without an active project** — it adopts the first
  registered project (and names it in the Model group's title) so the model
  picker is not empty after a cold start or a PWA launch. With no registered
  project at all, it says so and only Copy is available on a transcript.

## Implementation notes

- `src/transcribe.js` — the two request families, the response parsers, the
  family inference, and the candidate filter. Pure: multipart bodies are built
  by hand (not with `FormData`) so the wire shape can be asserted byte-for-byte
  in a test.
- `src/ai-endpoints.js` carries OpenRouter's `architecture.input_modalities`
  through to the model record as `inputModalities`. That is the capability
  signal the candidate filter uses for models whose names say nothing.
- `src/server-handlers-transcribe.js` — `GET /api/ai/transcribe/models` and
  `POST /api/ai/transcribe`. Resolves the model through the shared
  `resolveModel`, injects the credential server-side, applies the 60s deadline,
  and maps typed codes onto HTTP statuses. Mounted before the generic
  `/api/ai/` branch in `src/http-server.js`. The catalog merges the project
  models with the live lists; `?live=0` serves the project models alone (the
  page's fast first paint) and `?refresh=1` bypasses the live cache.
- `src/modelList.js` — the per-provider live model fetch and its hour-long
  cache, extracted from the `/api/ai/models/live` handler so the dictation
  catalog and the chat picker share one cache and one set of typed errors.
  `liveModelsForMany` is the best-effort fan-out used by dictation: one
  provider failing yields a `liveFailures` entry, not an empty list.
- `frontend/src/dictation.js` — the browser half: recorder capability probing,
  the clock, base64 encoding, the model-selection rules (`resolveDefaultModel`),
  and the transcript action set. Pure enough to unit-test.
- `frontend/src/components/DictationPage.jsx` — the Dictation page
  (`#/settings/dictation`; `#/dictation` is the legacy alias), reached from
  Settings → App defaults, and `frontend/src/components/chat/MicButton.jsx` — the
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
node scripts/test-dictation-ui.mjs    # a browser fixture: prints a URL, or
  # `--write <dir>` emits it to serve statically
```

The UI fixture has two scenarios, selected from its top bar (or by opening
`#live-only`): a project with its own model records, and a project with none
whose models come entirely from the provider's live list.

## Related

- [AI client](ai-client.md) — the chat proxy this endpoint sits beside.
- [Model picker](model-picker.md) — where the models come from.
- [App and project settings](app-and-project-settings.md) — the `dictation`
  app-level key and the project `models` array.
- [Routing](routing.md) — the `#/settings/dictation` route (and its `#/dictation` alias).
- Source: [`src/transcribe.js`](../../src/transcribe.js),
  [`src/server-handlers-transcribe.js`](../../src/server-handlers-transcribe.js),
  [`frontend/src/dictation.js`](../../frontend/src/dictation.js),
  [`frontend/src/components/DictationPage.jsx`](../../frontend/src/components/DictationPage.jsx).
