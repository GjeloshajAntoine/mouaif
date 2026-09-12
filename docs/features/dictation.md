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
2. Pick a **dictation model** (a model from the active project, or one the
  connected providers offer) under **Dictation model**; the dialect it will be
  sent in is shown underneath, read-only. There is usually nothing to pick: a
  remembered model, a lone candidate, or a lone row whose name says it
  transcribes is selected for you.
3. Tap **Record**. The timer and the level meter confirm the microphone is
   live. Recording stops on the second tap, or automatically at 2:00.
4. Tap **Transcribe**. The transcript appears in an editable field, and the
  line under it reports the run — model, size, duration and **what it cost**.
5. Choose what happens to it: **Copy**, **Insert in chat** (fills the newest
  chat's draft), **Send to chat** (same, labelled for a send), or **Clear**.

Optional per-run hints sit under the picker, folded away behind an **Options**
row (it shows whatever is set, so a value the user typed never looks lost):

- **Language** — an ISO-639-1 or BCP-47 code (`en`, `fr`, `de`), passed to the
  provider so it biases decoding instead of guessing.
- **Vocabulary hint** — names and jargon the provider should expect
  (`mouaif, MediaRecorder, SSE`). This is the OpenAI-style `prompt` field.

### The composer microphone

Inside a chat, the microphone button next to the image button records and
transcribes with the same remembered model, appending the text at the caret of
the draft. Nothing is sent: dictation produces a draft, and sending stays a
user decision. The chat's own status line under the composer confirms the
hand-off (`dictation added`), and the button's tooltip says the same in words.
If no dictation model has been chosen yet, the button says so
and points at **Settings → App defaults → Dictation**.

### What a run cost

A transcription is billed work, so both surfaces report what it cost:

- the **Dictation page** ends its "Last run" line with `cost $0.00055`;
- the **composer microphone** appends it to the chat's status line
  (`dictation added · $0.00055`) and repeats it in the button's tooltip.

The number is resolved server-side with the same pricing table the chat uses —
the model record's own `pricing`, then the app-level table, then the built-in
defaults — so a per-model override in `.mouaif.json` applies here too. See
[Usage metrics](usage-metrics.md).

`--` means *unknown*, not free, and it is the common answer:

| Situation | Cost line |
| --- | --- |
| the provider reported tokens, and the model has a price | `$0.00055` |
| the provider reported no tokens (`whisper-1` bills per minute and answers with the transcript alone) | `--` |
| no pricing record for the model anywhere | `--` |

The provider's report is normalized to `promptTokens` / `completionTokens`, so
the audio counts as input: Gemini's `usageMetadata` (audio rides in the prompt)
and the OpenAI-shaped `usage` block are both understood. A run that reports
nothing stays `null` all the way to the UI rather than becoming `0`.

**Dictation cost is not part of any chat or project total.** It is not a chat
turn, so the chat header's Total, the chat list and the project total are
unchanged by dictating — which is why the cost is printed at the point of use
instead. (Folding it into those sums would mean attributing a dictation run to a
chat, and is deliberately not done here.)

### The layout of the page

One column, mobile first: the recorder, the model, the folded **Options** row,
then the transcript. The group title names the control (*Dictation model*) rather
than labelling it a second time under itself, and the note beside it appears only
when it has something to say: the page adopts the first registered project on a
cold start or a PWA launch, the models then come from *that* project, and naming
it is the difference between "where did these come from" and a named source. When
the active project's catalog is already the one on offer, the note is empty rather
than a "this project" that restates the obvious.

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

Four signals decide whether a model is **offered**, cheapest first:

| Signal | Example |
| --- | --- |
| `transcription` is set | `"transcription": { "kind": "gemini" }` |
| the id looks like speech-to-text | `whisper-1`, `mistralai/voxtral-…`, `parakeet` |
| it resolves to the Gemini family | `gemini-2.5-flash` |
| the provider reports audio input | `openai/gpt-audio`, `meta/muse-spark-1.3` |

When none of them matches, everything is offered rather than nothing — a
self-hosted `my-asr` is exactly the case nothing can infer.

The **request shape** follows from the first of these that applies:

| Signal | Example | Shape |
| --- | --- | --- |
| `transcription.kind` is set | `"transcription": { "kind": "gemini" }` | as declared |
| the provider is one we ship | `gemini-2.5-flash` on `gemini` | the connection decides: Gemini on `gemini`, OpenAI-shaped on every other shipped provider |
| the provider is unknown and the id starts with `google/` | `google/gemini-2.5-flash` on a custom gateway | Gemini |
| nothing matches | — | OpenAI-shaped |

The last two matter on OpenRouter, which carries **no `whisper-*` at all**: its
transcribable models are ones whose names say nothing (`openai/gpt-audio`,
`mistralai/voxtral-small-24b-2507`, `meta/muse-spark`, `nvidia/nemotron-…-omni`).
It advertises each model's input modalities, so the catalog selects on that
capability instead of guessing from the name, and the picker labels such a row
`from provider · audio in`.

When none of them matches the model is still offered, and "is this a Gemini
model" is decided by the **provider** (and, for a provider we do not ship, by a
`google/` slug prefix) — never by a substring of the id. A substring test looked
harmless and was not: it swept up dozens of OpenRouter entries whose names merely
contain "gemini", which sent them to an endpoint that does not exist there.

There is no request-shape control: the shape follows from the model's provider
connection, which is the only thing that knows how to address it.

| Provider | Model id example | Request shape used |
| --- | --- | --- |
| OpenAI, Groq, Mistral, OpenRouter, self-hosted `/v1` | `whisper-1`, `whisper-large-v3`, `voxtral-mini-latest` | OpenAI-shaped (multipart) |
| Google Gemini | `gemini-2.5-flash` | Gemini (inline audio) |

The **Dictation model** picker lists the union of both sources, and the
read-only line under it names the dialect the selected model will be sent in.
The choice is remembered app-wide in the app store under the `dictation` key,
so the next session — and the composer microphone — use the same model.

### Choosing from the list

A connected provider's catalog is a chat catalog: hundreds of rows, rendered
provider by provider and alphabetically within each. Two things keep the
dictation list usable:

- **Recommended** — a short section at the top of the sheet holding the rows
  worth reaching first, in this order: ids that say they transcribe
  (`whisper-*`, `voxtral-*`, `parakeet-*`), then rows the provider reports as
  taking audio input, then Gemini models. Rows that Pinned or Recent already
  show are not repeated. The section only appears on the unfiltered list, so a
  search or a provider chip leaves just the matches.
- **A default worth adopting.** The remembered model wins; failing that, a
  single candidate, or a single row whose name says it transcribes, is adopted
  automatically. Two `whisper-*` rows from two providers (or rows whose names
  say nothing at all) leave the picker asking, because a wrong guess is a
  provider error, not a cosmetic surprise.

**Pinned** and **Recently used** come from the same places the chat picker uses
— pins per project in `localStorage`, recents from the server — so a model
pinned while chatting is offered first when dictating, and a model chosen in a
chat cannot appear here unless it can transcribe. See
[Model bookmarks](model-bookmarks.md).

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
- **Nothing is preselected when the choice is real.** A lone candidate, or a
  lone row whose name says it transcribes, is adopted; with two of either the
  picker asks.
- **The list is ordered for dictation, not for chat.** `recommendedModels`
  ranks rows by how much they say about themselves (`dictationRank`: name hint
  > audio input or Gemini > the user's own record > everything else) and the
  picker shows that short list above the provider sections, which stay
  alphabetical. The rank is display only — the transport is still the server's
  `kind`.
- **The choice is remembered app-wide**, under the `dictation` key in the app
  store, and written back on every change — including clearing it. That is what
  makes the composer microphone and a later visit agree with the page.
- **There is no request-shape control.** The dialect a model is sent with is a
  property of its provider connection, and the two families are not
  interchangeable — a Gemini connection pointed at `/audio/transcriptions`, or
  an OpenRouter connection pointed at `/v1beta/models/…:generateContent`, is a
  404. The page reports the shape it will use instead of letting it be set.
- **Failures name their cause.** A rejected key surfaces the provider's own
  message with HTTP 401, an unreachable provider is 502, a stalled one is 504
  after 60s, and a recording that is too long is 413.
- **A run reports what it cost, and says `--` when it cannot know.** The
  transcription response carries `usage` (the provider's own token report, or
  `null`) and `cost` (priced by the server from the same table the chat uses,
  with `known: false` when there is nothing to price). Both surfaces render the
  same `--` convention the chat's cost line uses; neither ever shows `$0.00`
  for work that was merely not reported.
- **A provider that could not list its models is named and explained.** The
  connection is called what Settings calls it (*OpenAI compatible*, not
  `openai-compatible`), the provider's own message is kept because it is the
  only thing that says *why* (`upstream 401 Unauthorized`), and the line is
  followed by the link that fixes it: **Check the connection in Settings →
  Providers**. Those rows are missing from the picker; the providers that did
  answer still are not.
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
  in a test. `usageFromResponse` reads the provider's token report for both
  families; `parseTranscribeResponse` carries it through as `usage` (or `null`).
- `src/usage.js` prices a run: the handler calls the same `computeCost` the chat
  uses, with the resolved model record (which already carries a live catalog
  entry's provider pricing) so a per-model override applies identically. No
  transcription ids are added to the built-in table: speech-to-text is usually
  billed per minute of audio, which `inputPer1K` / `outputPer1K` cannot express,
  and inventing a token price for it would be worse than `--`.
- `src/ai-endpoints.js` carries OpenRouter's `architecture.input_modalities`
  through to the model record as `inputModalities`. That is the capability
  signal the candidate filter uses for models whose names say nothing.
- `src/server-handlers-transcribe.js` — `GET /api/ai/transcribe/models` and
  `POST /api/ai/transcribe`. Resolves the model through the shared
  `resolveModel`, injects the credential server-side, applies the 60s deadline,
  prices the provider's usage report, and maps typed codes onto HTTP statuses.
  Mounted before the generic
  `/api/ai/` branch in `src/http-server.js`. The catalog merges the project
  models with the live lists; `?live=0` serves the project models alone (the
  page's fast first paint) and `?refresh=1` bypasses the live cache.
  `POST /api/ai/transcribe` answers `{ text, model, kind, bytes, durationMs,
  usage, cost }` — `usage: null` and `cost.known: false` when the provider
  reported nothing.
- `src/modelList.js` — the per-provider live model fetch and its hour-long
  cache, extracted from the `/api/ai/models/live` handler so the dictation
  catalog and the chat picker share one cache and one set of typed errors.
  `liveModelsForMany` is the best-effort fan-out used by dictation: one
  provider failing yields a `liveFailures` entry, not an empty list.
- `frontend/src/dictation.js` — the browser half: recorder capability probing,
  the clock, base64 encoding, the model-selection rules (`resolveDefaultModel`,
  `dictationRank`, `recommendedModels`, `defaultDictationModel`), and the
  transcript action set. Pure enough to unit-test.
- `frontend/src/components/ModelPickerField.jsx` — the shared picker, which
  takes an optional `recommended` list of rows to show above Pinned/Recent, and
  already owned the `pinned`/`onTogglePin`/`recent` props. The chat head and the
  dictation page are the same control with different props.
- `frontend/src/components/DictationPage.jsx` — the Dictation page
  (`#/settings/dictation`; `#/dictation` is the legacy alias), reached from
  Settings → App defaults, and `frontend/src/components/chat/MicButton.jsx` — the
  composer microphone. Both use the same helper module, so the two surfaces
  cannot disagree about the model or the dialect it is sent in. The page reuses
  `chat/modelPicker.js` for its pins and recents rather than reimplementing
  them, so a pin means the same thing on both surfaces.
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
node scripts/test-dictation-chat.cjs  # the composer mic inside the real
  # ChatView (needs debug Chrome; see CDP_URL below)
```

The UI fixture has two scenarios, selected from its top bar (or by opening
`#live-only`): a project with its own model records, and a project with none
whose models come entirely from the provider's live list.

`test-dictation-chat.cjs` mounts the real `App` → `ChatView` in an isolated
browser target with a stubbed `fetch`, a fake microphone and the real
stylesheet, then taps the composer microphone twice. It pins the four things
only that path can break: the model comes from the app-level `dictation` key
(not from the chat), the transcript is appended to the draft *and* persisted,
the run's cost reaches the chat's status line, and an unpriced run adds no
figure at all. It needs a debug Chrome (`CDP_URL`, default
`http://127.0.0.1:9222`), like the model-picker browser tests.

## Related

- [AI client](ai-client.md) — the chat proxy this endpoint sits beside.
- [Usage metrics](usage-metrics.md) — the pricing table a run's cost is resolved from.
- [Model picker](model-picker.md) — where the models come from.
- [App and project settings](app-and-project-settings.md) — the `dictation`
  app-level key and the project `models` array.
- [Routing](routing.md) — the `#/settings/dictation` route (and its `#/dictation` alias).
- Source: [`src/transcribe.js`](../../src/transcribe.js),
  [`src/server-handlers-transcribe.js`](../../src/server-handlers-transcribe.js),
  [`frontend/src/dictation.js`](../../frontend/src/dictation.js),
  [`frontend/src/components/DictationPage.jsx`](../../frontend/src/components/DictationPage.jsx).
