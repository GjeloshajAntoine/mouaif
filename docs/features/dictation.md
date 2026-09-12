# Dictation

## Overview

Dictation turns speech into text using a model the user picks, and hands that
text to the app rather than sending it. It has two surfaces: a **Dictation**
page under Settings that records, transcribes and shows an editable
transcript, and a **microphone button in the chat composer** that transcribes
*while the user speaks* and grows the draft as the words arrive. The provider
credential never reaches the browser: the recording — or each chunk of it — is
posted to `POST /api/ai/transcribe` and the server performs the upstream call.

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

- **Live transcription** — the composer microphone transcribes while you
  speak. On by default; off makes a chat take behave like this page (record,
  stop, one request). The collapsed row always says which state it is in
  (`live on` / `live off`), because it is the one setting here that changes
  what another screen does.
- **Language** — an ISO-639-1 or BCP-47 code (`en`, `fr`, `de`), passed to the
  provider so it biases decoding instead of guessing.
- **Vocabulary hint** — names and jargon the provider should expect
  (`mouaif, MediaRecorder, SSE`). This is the OpenAI-style `prompt` field.

### The composer microphone

Inside a chat, the microphone button dictates **as you speak**. The recorder is
given a 3-second timeslice, every chunk is posted as it arrives, and the
transcript appears in the draft at the caret while the take is still running.
Nothing is sent: dictation produces a draft, and sending stays a user decision.
The chat's status line under the composer is the live indicator (`12 words so
far — tap the mic to stop.`), the button's tooltip carries the running clock
(`Stop dictation (0:14)`), and the second tap closes the take and reports it
(`dictation added`, plus the run's cost when it is priced).

**Live transcription** is on by default and is switched off in the dictation
page's **Options** row (Settings → App defaults → Dictation). With it off the
composer mic behaves the way it always did: one recording, one request, one
transcript when the button is tapped a second time. Turn it off for a model
that bills per minute or that rejects a chunk of audio on its own.

The model is resolved **before** the microphone opens, so a chat with no
dictation model configured reports the reason in that same status line —
`No dictation model yet — Open Settings → App defaults → Dictation to pick a
dictation model.`, marked as an error and with nothing recorded. Everything the
button does or fails to do (recording, transcribing, a provider rejection) is
written there too: the button's own `title` is a hover affordance, and a phone
has none.

#### How a live take is put together

The recorder's timeslices are contiguous, so each one is transcribed as if it
were a small recording and the answers are concatenated in speaking order.
Three rules make that read as one transcript:

- **Spoken order, not arrival order.** Each chunk's transcript is kept under
  the index the recorder gave it, so a chunk that is answered after a later one
  is still spliced in where it was spoken.
- **A seam is not repeated.** A provider restarts its context at every chunk,
  so the words at the boundary are commonly written twice (`… please save the
  note` / `note is saved`). The join drops the longest repeated run between two
  consecutive segments — words, not characters, so a sentence ending and the
  next one starting on the same word is repaired while `within` / `income` is
  not.
- **A failure is not data loss.** A chunk that fails is skipped, and the next
  answer is the transcript of the whole live region rather than of its own
  words, so nothing said during the failure is lost. The status line says
  `a chunk could not be transcribed; still listening…` while it happens, and the
  take closes with `Added to the composer — part of what you said could not be
  transcribed.` if it never recovered.

The tail is *replaced*, never appended to twice: the chat view remembers where
the live region starts, so the user's own text before the caret is untouched,
the caret stays at the end of the growing transcript, and a take that is
finished rewrites that region once with the final text.

A live take reports **no cost**. A chunk is a partial run of the audio, not the
whole dictation, and pricing it would be a guess; the status line for a live
take therefore says what happened to the take, while the dictation page (one
request, one priced run) keeps its full `Last run` line. Use the page when you
want to see what a transcription cost.

### What a run cost

A transcription is billed work, so the page and the composer both account for
it — with one deliberate exception:

- the **Dictation page** ends its "Last run" line with `cost $0.00055`;
- the **composer microphone** appends it to the chat's status line for a take
  transcribed in one request (`dictation added · $0.00055`) and repeats it in
  the button's tooltip;
- a **live take** (see the composer microphone below) reports no figure at all.
  Its cost is per chunk and unknowable until the take ends, and a fabricated
  price is worse than none.

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
  Providers is asked for its current catalog — the speech-to-text slice of it
  where the provider publishes one (OpenRouter) — and the entries that can
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

Five signals decide whether a model is **offered**, most trustworthy first:

| Signal | Example |
| --- | --- |
| `transcription` is set | `"transcription": { "kind": "gemini" }` |
| the provider reports `transcription` output | `openai/whisper-1` in OpenRouter's transcription catalog |
| the id looks like speech-to-text | `whisper-1`, `mistralai/voxtral-…`, `parakeet` |
| it resolves to the Gemini family | `gemini-2.5-flash` |
| the provider reports audio input, and no output report | `meta/muse-spark-1.3` on a provider that reports inputs only |

The provider's output report settles the question in both directions. A row
whose outputs include `transcription` is a transcriber whatever its name says
(`google/chirp-3`, `deepgram/nova-3`); a row whose outputs are reported and
*exclude* it is not one, however much audio it accepts — `openai/gpt-audio`
and `google/gemini-2.5-flash` both take audio input and both answer
`/audio/transcriptions` with `400 Model … does not exist`. Only when there is
no output report at all does the filter fall back to names and capabilities.

When none of them matches, everything is offered rather than nothing — a
self-hosted `my-asr` is exactly the case nothing can infer. A catalog the
provider *did* classify, where none of the rows produces transcripts, is a
different answer rather than a gap: those rows are the ones the endpoint
rejects, so the picker offers none of them instead of all.

The **request shape** follows from the first of these that applies:

| Signal | Example | Shape |
| --- | --- | --- |
| `transcription.kind` is set | `"transcription": { "kind": "gemini" }` | as declared |
| the provider is one we ship | `gemini-2.5-flash` on `gemini` | the connection decides: Gemini on `gemini`, OpenAI-shaped on every other shipped provider |
| the provider is unknown and the id starts with `google/` | `google/gemini-2.5-flash` on a custom gateway | Gemini |
| nothing matches | — | OpenAI-shaped |

The last two matter on OpenRouter, whose chat catalog carries no speech-to-text
model at all: `/models` is sliced by output modality and defaults to
`output_modalities=text`, so `openai/whisper-1` and the other 20 transcribers
live in a *different* slice of the same endpoint that only the dictation
catalog asks for. What the chat list does carry is a family of audio-*input*
chat models (`openai/gpt-audio`, `google/gemini-2.5-flash`,
`mistralai/voxtral-small-24b-2507`), and every one of those is rejected by
`/audio/transcriptions`. The catalog therefore selects on the provider's
reported outputs, and the picker labels an audio-capable chat row
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
provider by provider and alphabetically within each — except on a provider that
publishes a separate transcription catalog (OpenRouter's 21 speech-to-text
models), where the list *is* the transcription slice. Two things keep the
dictation list usable:

- **Recommended** — a short section at the top of the sheet holding the rows
  worth reaching first, in this order: rows the provider reports as producing
  transcripts, then ids that say they transcribe (`whisper-*`, `voxtral-*`,
  `parakeet-*`), then rows the provider reports as taking audio input, then
  Gemini models. Rows that Pinned or Recent already show are not repeated. The
  section only appears on the unfiltered list, so a search or a provider chip
  leaves just the matches.
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
- **A live take stops being live when the take stops.** Chunks still in flight
  when the user taps are awaited before the take is closed — the last words are
  the ones most likely to be in a request — and nothing is published after the
  take settles.
- **Live dictation needs a recorder that timeslices.** `recorder.start(ms)` is
  the one API the live path rests on; when the browser's recorder does not take
  a timeslice, the take silently uses the one-request-on-stop path instead of
  sending a single chunk as if it were the whole recording.
- **A provider that wants a whole file still works.** A chunk is a valid
  container on its own (every timeslice of a MediaRecorder stream is), so the
  same `/audio/transcriptions` and Gemini call paths serve it; a model that
  cannot handle short audio is the reason the switch exists.
- **The container follows the browser.** Opus-in-WebM on Chromium, Ogg/Opus on
  Firefox, MP4/AAC on Safari; the first type the browser reports as supported
  wins, and the recorder's own `mimeType` is used afterwards.
- **Nothing is auto-sent.** The composer hand-off fills a draft; the dictate
  page fills the newest chat's draft.
- **A failure is visible where the run happened.** The composer microphone
  writes its progress and its errors to the chat's status line, which is the
  only feedback a phone shows — its own report is a `title`. It also resolves
  the model *before* opening the microphone, so a chat with nothing configured
  says so instead of recording a take it cannot send. In a live take the line
  counts the words as they land, says when a chunk failed, and names what
  survived (`Added to the composer — part of what you said could not be
  transcribed.`) — the transcript itself is never rolled back over a failure.
- **The model list is the union of two sources**: the project's `models`
  (filtered to the ones that can plausibly transcribe) and the connected
  providers' live catalogs (filtered the same way, and labelled as coming from
  the provider; a provider that publishes a separate transcription catalog is
  read from that slice instead of from its chat list). A project record for an
  id wins over the live row for it.
- **A provider that cannot transcribe a row is not offered it.** A speech-to-text
  endpoint accepts a small, specific set of models, and the ones that merely
  *take audio* are not in it: OpenRouter answers `400 Model openai/gpt-audio
  does not exist` for the model its own chat catalog advertises. The catalog
  trusts what the provider reports about a model's output over what its name
  suggests.
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
  ranks rows by how much they say about themselves (`dictationRank`: the
  provider's transcription report or a name hint > audio input or Gemini > the
  user's own record > everything else) and the
  picker shows that short list above the provider sections, which stay
  alphabetical. The rank is display only — the transport is still the server's
  `kind`.
- **The choice is remembered app-wide**, under the `dictation` key in the app
  store, and written back on every change — including clearing it. That is what
  makes the composer microphone and a later visit agree with the page.
  Remembering it takes two server-side registrations, not one: the key must be
  in the client snapshot allowlist (`CLIENT_SETTINGS_KEYS`), or the store keeps
  it and the response drops it, which reads exactly like a pick that never
  saved — the page came up on "Pick a model" on every visit and the microphone
  answered "No dictation model yet" however often a model was chosen. It is
  also in `RESETTABLE_APP_KEYS`, so **Settings → About → Reset** can clear it.
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
- `src/ai-endpoints.js` carries OpenRouter's
  `architecture.input_modalities` / `architecture.output_modalities` through to
  the model record as `inputModalities` / `outputModalities`. Those are the
  capability reports the candidate filter uses, for and against a model whose
  name says nothing. The same file owns OpenRouter's optional
  `listTranscriptionModels` adapter, which reads
  `/models?output_modalities=transcription`: the chat list cannot be filtered
  into a dictation catalog there, because the 21 speech-to-text models are not
  in it and the audio-input chat models that are in it cannot transcribe.
- `src/server-handlers-transcribe.js` — `GET /api/ai/transcribe/models` and
  `POST /api/ai/transcribe`. Resolves the model through the shared
  `resolveModel`, injects the credential server-side, applies the 60s deadline,
  prices the provider's usage report, and maps typed codes onto HTTP statuses.
  Mounted before the generic
  `/api/ai/` branch in `src/http-server.js`. The catalog merges the project
  models with the live lists — read as the provider's *transcription* slice,
  which is cached under its own key so the chat picker and this one cannot
  serve each other's rows; `?live=0` serves the project models alone (the
  page's fast first paint) and `?refresh=1` bypasses the live cache.
  `POST /api/ai/transcribe` answers `{ text, model, kind, bytes, durationMs,
  usage, cost }` — `usage: null` and `cost.known: false` when the provider
  reported nothing.
- `src/modelList.js` — the per-provider live model fetch and its hour-long
  cache, extracted from the `/api/ai/models/live` handler so the dictation
  catalog and the chat picker share one fetch and one set of typed errors.
  `opts.purpose` selects the slice (`chat` by default, `transcription` for
  dictation) and `modelListCacheKey` keeps the two apart.
  `liveModelsForMany` is the best-effort fan-out used by dictation: one
  provider failing yields a `liveFailures` entry, not an empty list.
- `frontend/src/dictation.js` — the browser half: recorder capability probing,
  the clock, base64 encoding, the model-selection rules (`resolveDefaultModel`,
  `dictationRank`, `recommendedModels`, `defaultDictationModel`), the live-take
  helpers (`LIVE_CHUNK_MS`, `joinTranscript`, `seamOverlap`,
  `createLiveSegments`, `liveDictationEnabled`), and the transcript action set.
  Pure enough to unit-test: the join and the slot-ordering rules are decided
  from values alone, which is why they are not asserted through a recorder.
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
  them, so a pin means the same thing on both surfaces. `MicButton` starts the
  recorder *with* a timeslice exactly when the app-level choice says live and
  the recorder supports it; a recorder whose `start` takes no timeslice falls
  back to the one-request-on-stop path rather than sending a single chunk as if
  it were the whole take.
- `frontend/src/components/chat/Chat.jsx` — owns the chat's status line, so the
  microphone takes an `onStatus(message, state)` callback and writes its
  progress and failures there (`Chat.jsx` → `setStatus`). It also owns the
  draft, so a live chunk is written through `onTranscript(text, { live: true })`
  — `live` tells `onTranscript` that this write owns a *tail* of the composer
  and the next one replaces it instead of appending again (the tail is found by
  the offset it recorded, and replaced at the caret when the user has edited it
  away). Progress messages go to `onProgress`, which sets the same status
  element imperatively without a `say()` round trip. The success hand-off is
  the one message the button keeps to itself: `onTranscript` has already
  written the chat's own `dictation added · $…` line, and a second wording of
  the same event would replace the cost with a sentence.
- `frontend/src/dictation.css` — the page and the microphone button. Mobile
  first: one column, a 56px primary control, ≥44px taps, `dvh` for the iOS
  keyboard, and a `prefers-reduced-motion` branch for the pulse. The chat's
  status line carries the microphone's messages, so
  `frontend/src/chat-composer.css` gives that line a colour per `data-state`
  (`error`, `success`, `busy`): a failure written there in the same muted grey
  as everything else is a failure nobody notices at 0.7rem.
- `src/server-shared.js` — `'dictation'` in `CLIENT_SETTINGS_KEYS` (the
  allowlist every `/api/settings` response is filtered through) and in
  `RESETTABLE_APP_KEYS`. The app store holds the key either way; without the
  allowlist entry the choice exists in SQLite and is invisible to both
  surfaces that read it.
- The audio body is JSON base64 (`audioBase64`), capped at ~20 MB of audio,
  so one code path owns reading the body, its size limit and its error shape.

### Tests

```bash
node scripts/test-dictation.js        # request/response shapes, helper rules,
  # the live-take join and slot ordering, and the app-store allowlists the
  # choice needs
node scripts/test-dictation-http.mjs  # the real serve handlers, mock upstream
node scripts/test-dictation-page.mjs  # the page rendered against a fake API
node scripts/test-dictation-catalog-live.mjs  # the candidate filter against
  # the two real OpenRouter catalogs, replayed from scripts/fixtures/
  # dictation-openrouter-models.json (chat) and -stt-models.json
  # (transcription); `--record` refreshes both from the live API
node scripts/test-dictation-ui.mjs    # a browser fixture: prints a URL, or
  # `--write <dir>` emits it to serve statically. Its fake recorder emits a
  # chunk every 250 ms, so the composer-mic scenario shows a live take end to
  # end — the draft filling in, then settling — in a couple of seconds.
node scripts/test-dictation-chat.cjs  # the composer mic inside the real
  # ChatView (needs debug Chrome; see CDP_URL below). Its fake recorder is
  # stop-driven, so this is the *non-live* path: one request, appended once.
```

The UI fixture has two scenarios, selected from its top bar (or by opening
`#live-only`): a project with its own model records, and a project with none
whose models come entirely from the provider's live list.

`test-dictation-chat.cjs` mounts the real `App` → `ChatView` in an isolated
browser target with a stubbed `fetch`, a fake microphone and the real
stylesheet, then taps the composer microphone twice. It pins the things only
that path can break: the model comes from the app-level `dictation` key (not
from the chat), the transcript is appended to the draft *and* persisted, the
run's cost reaches the chat's status line, an unpriced run adds no figure at
all, and a tap with nothing configured reports why in that same line without
opening the microphone. It needs a debug Chrome (`CDP_URL`, default
`http://127.0.0.1:9222`), like the model-picker browser tests.

The live path is covered by `test-dictation.js` (the join, the seam and the
slot ordering — the parts a recorder cannot decide) and by the UI fixture's
composer-mic scenario (the wiring: a chunk write replacing the tail, the take
settling once).

## Related

- [AI client](ai-client.md) — the chat proxy this endpoint sits beside.
- [Usage metrics](usage-metrics.md) — the pricing table a run's cost is resolved from.
- [Model picker](model-picker.md) — where the models come from.
- [App and project settings](app-and-project-settings.md) — the `dictation`
  app-level key and the project `models` array.
- [Routing](routing.md) — the `#/settings/dictation` route (and its `#/dictation` alias).
- Source: [`src/transcribe.js`](../../src/transcribe.js),
  [`src/server-handlers-transcribe.js`](../../src/server-handlers-transcribe.js),
  [`src/ai-endpoints.js`](../../src/ai-endpoints.js) (`listTranscriptionModels`),
  [`frontend/src/dictation.js`](../../frontend/src/dictation.js),
  [`frontend/src/components/DictationPage.jsx`](../../frontend/src/components/DictationPage.jsx).
