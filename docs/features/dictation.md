# Dictation

## Overview

Dictation turns speech into text using a model the user picks, and hands that
text to the app rather than sending it. It has two surfaces: a **Dictation**
page under Settings that records, transcribes and shows an editable
transcript, and a **microphone button in the chat composer** that transcribes
*while the user speaks* and grows the draft as the words arrive. The provider
credential never reaches the browser: the recording — or each segment of it — is
posted to `POST /api/ai/transcribe` and the server performs the upstream call.

## Usage

### The Dictation page

1. Open **Settings → App defaults → Dictation** (or `#/settings/dictation`).
2. Pick a **dictation model** (a model from the active project, or one the
  connected providers offer) under **Dictation model**; the dialect it will be
  sent in is shown underneath, read-only. There is usually nothing to pick: a
  remembered model, a lone candidate, or a lone row whose name says it
  transcribes is selected for you.
3. In the **Test** card below, tap **Record**. The timer and the level meter
   confirm the microphone is live. Recording stops on the second tap, or
   automatically at 2:00.
4. Tap **Transcribe**. The transcript appears in an editable field, and the
  line under it reports the run — model, size, duration and **what it cost**.
5. Choose what happens to it: **Copy**, **Insert in chat** (fills the newest
  chat's draft), **Send to chat** (same, labelled for a send), or **Clear**.

Optional per-run hints sit under the picker, as a plain item list — one row
each, no disclosure, so every setting is on the page at once:

- **Live transcription** — the composer microphone transcribes while you
  speak. On by default; off makes a chat take behave like this page (record,
  stop, one request). The row carries a switch, so its state is always visible
  without opening anything.
- **Language** — an ISO-639-1 or BCP-47 code (`en`, `fr`, `de`), passed to the
  provider so it biases decoding instead of guessing.
- **Vocabulary hint** — names and jargon the provider should expect
  (`mouaif, MediaRecorder, SSE`). This is the OpenAI-style `prompt` field.

### The composer microphone

Inside a chat, the microphone button dictates **as you speak**. The take is cut
into 3-second **segments**, each one a complete recording, and every finished
segment is posted as it arrives — so the transcript appears in the draft at the
caret while the take is still running. Nothing is sent: dictation produces a
draft, and sending stays a user decision.
The chat's status line under the composer is the live indicator (`12 words so
far — tap the mic to stop.`), the button's tooltip carries the running clock
(`Stop dictation (0:14)`), and the second tap closes the take and reports it
(`dictation added`, plus the run's cost when it is priced).

**Live transcription** is on by default and is switched off in the dictation
page's **Live transcription** row (Settings → App defaults → Dictation). With it off the
composer mic behaves the way it always did: one recording, one request, one
transcript when the button is tapped a second time. Turn it off for a model
that bills per minute or that rejects a short recording on its own.

The model is resolved **before** the microphone opens, so a chat with no
dictation model configured reports the reason in that same status line —
`No dictation model yet — Open Settings → App defaults → Dictation to pick a
dictation model.`, marked as an error and with nothing recorded. Everything the
button does or fails to do (recording, transcribing, a provider rejection) is
written there too: the button's own `title` is a hover affordance, and a phone
has none.
The whole button can be kept out of the composer row with **Settings → App
defaults → Chat defaults → Dictation microphone in the composer**. That switch
(`dictationButton`, on by default) only decides whether the row draws the
button: the dictation page, the remembered model and `POST /api/ai/transcribe`
are untouched, so nothing is disabled. See
[Composer tool buttons](./composer-tool-buttons.md).

#### How a live take is put together

A live take is a **series of complete recordings**, not one recording sliced up,
and each one is transcribed as if it were a take from the dictation page:

- **A segment is a file.** The take rotates the recorder every 3 seconds
  (`LIVE_CHUNK_MS`), so the browser's own muxer writes each segment — container
  header, tracks and timestamps included — and stops it cleanly. A
  `MediaRecorder` *timeslice* cannot do this: it cuts the byte stream wherever
  the flush lands, so only the first slice carries the container header and
  every later slice is a raw continuation of a cluster. A provider's decoder
  gets no header, no tracks and no timestamps from a fragment like that, so it
  answers with an error or with nothing at all — a live take used to transcribe
  only its first ~3 s, which is why the same words read far worse in the
  composer than on this page.
- **A boundary is a few milliseconds.** Rotating costs a gap between two
  recordings (measured in Chrome on the order of 2 ms) instead of a broken file,
  and the final, partial segment is still sent when the user stops — a take is
  never left with its last words unsent.

Three rules then make the segments read as one transcript:

- **Spoken order, not arrival order.** Each segment's transcript is kept under
  the index the recorder produced it in, so a segment that is answered after a
  later one is still spliced in where it was spoken.
- **A seam is not repeated.** A provider restarts its context at every segment,
  so the words at the boundary are commonly written twice (`… please save the
  note` / `note is saved`). The join drops the longest repeated run between two
  consecutive segments — words, not characters, so a sentence ending and the
  next one starting on the same word is repaired while `within` / `income` is
  not.
- **A failure is not data loss.** A segment that fails is skipped, and the next
  answer is the transcript of the whole live region rather than of its own
  words, so nothing said during the failure is lost. The status line says
  `part of what you said could not be transcribed; still listening…` while it
  happens, and the take closes with `Added to the composer — part of what you
  said could not be transcribed.` if it never recovered.

The tail is *replaced*, never appended to twice: the chat view remembers where
the live region starts, so the user's own text before the caret is untouched,
the caret stays at the end of the growing transcript, and a take that is
finished rewrites that region once with the final text.

A live take reports **no cost per segment**. Each segment is a partial run of
the audio, not the whole dictation, so pricing one would be a guess and the
status line for a live take therefore says what happened to the take while it
runs. When the take ends, however, its segments have each been billed — so the
take **settles with the sum of the prices its segments answered with**, and that
is the figure the status line reports and the number attributed to the chat. A
live take whose segments were all unpriced reports nothing at all. The dictation page
(one request, one priced run) keeps its full `Last run` line either way.

### What a run cost

A transcription is billed work, so the page and the composer both account for
it — with one deliberate exception:

- the **Dictation page** ends its "Last run" line with `cost $0.00055`;
- the **composer microphone** appends it to the chat's status line
  (`dictation added · $0.00055`) and repeats it in the button's tooltip, **and
  attributes the priced run to the chat**, so the header Total, the chat list
  row and the project total all move by it (see below);
- a **live take** reports no figure while it runs — a segment is a partial run
  and the take has no price yet — but the take **settles with the sum of its
  segments' prices** (`liveTakeCost`) once every one has answered, so a finished
  live take reports and attributes its cost exactly like a one-request take; a
  live take whose segments were all unpriced reports nothing.

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

**A dictation run taken in a chat joins that chat's Total.** The composer
microphone attributes the run to the chat it happened in, so the priced run is
added to the chat header's Total, the chat list row and the registered project
total — the same persisted counters an assistant turn updates. It is not a chat
turn: no message row is written, the transcript lands in the composer draft, and
the status line still prints the figure at the moment it happened. A run taken
on the **Dictation page** belongs to no chat and stays point-of-use only, and a
run whose cost is unknown (`--`) adds nothing to any total anywhere.

### The layout of the page

One column, mobile first, and the sections are ordered **settings first, test
below**: *Dictation model* (with the options list and the catalog
note), then *Test* — the record button, timer and level meter — then
*Transcript*. The model has to be answered before a take can be transcribed at
all, so it is picked before the microphone is opened; a phone user chooses a
model once and records many times, and keeping the recorder at the top pushed
the transcript, which is what the page is for, off the fold. The **Test** group
title says what the card under it does; the record button keeps its own
`Record` / `Stop` / `Record again` caption. The group title names the control
(*Dictation model*) rather
than labelling it a second time under itself, and the note beside it appears only
when it has something to say: the page adopts the first registered project on a
cold start or a PWA launch, the models then come from *that* project, and naming
it is the difference between "where did these come from" and a named source. When
the active project's catalog is already the one on offer, the note is empty rather
than a "this project" that restates the obvious.

### What the surfaces show while they work

Dictation is a chain of waits — two catalog reads before the microphone opens, a
transcription after it closes, a hand-off that writes a chat's draft — and each
one leaves the user looking at a screen that has not changed yet. So every wait
is *reported*, on the control that was tapped and next to the thing that is
being waited on, and the report is the same one a screen reader gets:

- the **catalog read-out** under the model picker leads with a spinner and says
  what it is waiting for (`Loading models…`, then `Looking for models from your
  providers…` while the provider pass runs), with `aria-busy` on the line.
  Before this, the first paint of a fresh install said **No models** — the one
  conclusion a request that has not answered yet must not invite;
- the **Transcribe** button holds a spinner and an `aria-busy` while its
  request is in flight, and the **Record** button takes the spinner for a
  hand-off (that is what its `Working…` label was already reporting), so the
  ring is always on the control the user tapped rather than on the one next to
  it;
- the **composer microphone** shows a spinner in place of its glyph and is
reported as busy (`aria-busy`) while it transcribes — a greyed-out mic with an
unchanged glyph read as "the tap did nothing". That loading state belongs to the
*transcription request* and to nothing else, which on a live take is **two**
moments, not one: the requests made while the user speaks, and the last segment
(or a segment still in flight) that is still being transcribed *after* they
tapped to stop. The second one used to be missing — the take went back to a
plain microphone and its `N words so far — tap the mic to stop.` line while its
final words were in fact still being transcribed — so the button now holds the
spinner and `Working…` for the whole settle, and the chat's status row says
`Transcribing…` until `dictation added` lands. A tap's other wait, the **model
resolve** (two reads before the microphone opens), transcribes nothing and would
be a spinner for an operation the user has not started, so it is never shown on
the button. What it gets instead is a sentence in the chat's status line
(`Preparing dictation…`), and only after it has outlasted `MIC_WAIT_DELAY_MS`
(400 ms): on a healthy connection those reads answer inside a frame, so a
sentence painted and gone again is not worth reading, while a cold provider
catalog (a round trip per connection) is a wait the user is owed a word about.
The chat's status line says `Transcribing…` for the run, and a live take keeps
counting words there while it is still listening.

The decisions behind those affordances are pure functions in
`frontend/src/dictation.js`, so the wording and the phase cannot drift from the
state that produces them:
```js
// What the read-out says, and whether it is a spinner or a sentence.
catalogNote({ catalogBusy, liveBusy, projectCount, hasLive })
// -> { text: 'Loading models…', loading: true }
// Which wait is in flight; a long wait (the catalog) wins over a short one.
busyPhase({ catalogBusy, liveBusy, transcribing, handoff })
// -> '' | 'catalog' | 'live' | 'transcribe' | 'handoff'
// The composer mic's loading state: a transcription request in flight, in
// either of its two shapes — a one-request take (`transcribing`) or a live
// take still transcribing its last segment (`finishing`) — and nothing else
// (never the model resolve).
micWaitPhase({ transcribing, finishing })
// -> '' | 'transcribe'
// The sentence the live take's settle writes to the chat's status row.
MIC_TRANSCRIBE_NOTE // -> 'Transcribing…'
// What a tap says while it resolves the model, once that wait is worth a word.
micResolveNote({ preparing, delayMs })
// -> '' | 'Preparing dictation…'
```
`micWaitPhase` and `micResolveNote` are the two halves of one rule: a spinner
belongs to the request the button is actually processing, and a wait that has no
request behind it (and no audio) gets words instead. `micWaitPhase` reads the
request itself, not the moment the user tapped: a live take's requests outlive
the stop that ends it, so `finishing` — "stopped, and a segment has not
answered" — is the same loading state as `transcribing`.

Every spinner is decoration over a sentence or an `aria-busy`, and it is a
`currentColor` ring so it inherits the accent inside a primary button and the
muted tone inside the mic button. Under `prefers-reduced-motion: reduce` the
animation stops but the ring stays — a static ring with its coloured top arc
still reads as "working", and the words beside it are unaffected.

### Configuring a model

The **Dictation** page lists two kinds of model, and you do not have to
configure anything for the first one:

1. **Models from your providers.** Every connected provider in Settings →
  Providers is asked for its current catalog — the speech-to-text slice of it
  where the provider publishes one (OpenRouter), *and* the chat slice for
  OpenRouter, because that is where its Google models live — and the entries
  that can be dictated with are listed. `Refresh` re-reads them (the lists are
  cached server-side for an hour). This is what makes a fresh install work with
  no setup: connect a Gemini key and `gemini-2.5-flash` is offered; connect an
  OpenRouter key and `google/gemini-3.5-flash` is offered alongside
  `openai/whisper-large-v3`.
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
| the model can be sent audio over the chat route (see below) | `google/gemini-3.5-flash`, `openai/gpt-audio` on OpenRouter |
| the id looks like speech-to-text | `whisper-1`, `mistralai/voxtral-…`, `parakeet` |
| it resolves to the Gemini family | `gemini-2.5-flash` |
| the provider reports audio input, and no output report | `meta/muse-spark-1.3` on a provider that reports inputs only |

The provider's output report settles the question in both directions. A row
whose outputs include `transcription` is a transcriber whatever its name says
(`google/chirp-3`, `deepgram/nova-3`); a row whose outputs are *reported* and
exclude it is a transcriber only if the chat route can carry its audio (next
section) — otherwise it is not one, however much audio it accepts. Only when
there is no output report at all does the filter fall back to names and
capabilities.

When none of them matches, everything is offered rather than nothing — a
self-hosted `my-asr` is exactly the case nothing can infer. A catalog the
provider *did* classify, where no row can be dictated with, is a different
answer rather than a gap: the picker offers none of them instead of all.

#### Two OpenAI-shaped routes, and which one a row takes

A model that can hear has two ways in, and picking the wrong one is a provider
error rather than a preference:

| Route | Endpoint | For |
| --- | --- | --- |
| `openai-compatible` | `POST /audio/transcriptions` (multipart) | every model that has an entry there: `openai/whisper-large-v3`, `google/chirp-3`, `mistralai/voxtral-mini-transcribe` |
| `openai-audio` | `POST /chat/completions` (inline `input_audio`) | a model with no such entry that the provider reports as taking audio: `google/gemini-3.5-flash`, `~google/gemini-flash-latest`, `openai/gpt-audio` |
| `gemini` | `POST /v1beta/models/{model}:generateContent` | the native Gemini connection |

The second route exists because of **OpenRouter's Google models**, and that is
the bug it fixes. OpenRouter slices `GET /api/v1/models` by output modality, and
a Google Gemini row is filed under `output_modalities: ["text"]` — so
`google/gemini-3.5-flash` is in the *chat* catalog, is absent from the
transcription slice (`?output_modalities=transcription`, whose one Google row is
`google/chirp-3`), and is answered by `/audio/transcriptions` with
`400 Model google/gemini-3.5-flash does not exist`. Reading only the
transcription slice therefore left the picker with no Google chat model at all,
which reads from the phone as "Google models are not available on OpenRouter".
The model was always there and always able to transcribe; the catalog was asking
the wrong endpoint. The same audio, sent as an `input_audio` part on a chat
completion, comes back with the transcript and a billed `usage` report.

A row takes the chat route when **all** of these hold:

- its connection is OpenAI-shaped (so `/chat/completions` is what it speaks);
- the provider reports `audio` among its input modalities — a report we do not
  have is not evidence, so an unclassified row keeps the multipart default;
- its reported outputs do **not** already include `transcription` — such a row
  has a real multipart entry, which is the cheaper, purpose-built call;
- its id does not name itself a transcriber (`whisper-…`, `…-transcribe`,
  `voxtral-…`, `parakeet-…`);
- its id is not a `:batch` row (`google/gemini-3.8-flash:batch`). Those share
  their interactive twin's capability report but are served by the Batch API —
  submit a job, poll it — which a microphone tap cannot do.

The picker shows which route the selected row will use under **Sends as**
(`OpenAI chat` for this one), and the choice travels with the request, so what
the user was shown is what is sent.

#### Gemini's two transcript shapes

The native Gemini connection has two ways to answer a transcription, and which
one you get depends on the model:

- a **general** model (`gemini-3.8-flash`) replies in `parts[].text` — the audio
  is just another input and the transcript just another answer;
- a **transcription** model (`gemini-3.5-transcribe`) replies in
  `parts[].audioTranscription.text`, with `parts[].text` present but *empty*.

Both are read. Parsing only `text` turned the second shape into `EEMPTY` — "the
provider returned no transcript" — for a response that contained one, which is
what made the dedicated transcription models look broken.

The **request shape** follows from the first of these that applies:

| Signal | Example | Shape |
| --- | --- | --- |
| `transcription.kind` is set | `"transcription": { "kind": "gemini" }` | as declared |
| the row was classified as audio-in on an OpenAI-shaped connection | `google/gemini-3.5-flash` | OpenAI-shaped, inline audio on `/chat/completions` |
| the provider is one we ship | `gemini-2.5-flash` on `gemini` | the connection decides: Gemini on `gemini`, OpenAI-shaped on every other shipped provider |
| the provider is unknown and the id starts with `google/` | `google/gemini-2.5-flash` on a custom gateway | Gemini |
| nothing matches | — | OpenAI-shaped, multipart |

"Is this a Gemini model" is decided by the **provider** (and, for a provider we
do not ship, by a `google/` slug prefix) — never by a substring of the id. A
substring test looked harmless and was not: it swept up dozens of OpenRouter
entries whose names merely contain "gemini", which sent them to an endpoint that
does not exist there.

There is no request-shape control: the shape follows from the model's provider
connection *and the provider's capability report*, which between them are the
only things that know how to address it.

| Provider | Model id example | Request shape used |
| --- | --- | --- |
| OpenAI, Groq, Mistral, self-hosted `/v1` | `whisper-1`, `whisper-large-v3` | OpenAI-shaped (multipart) |
| OpenRouter, speech-to-text row | `openai/whisper-large-v3`, `google/chirp-3`, `deepgram/nova-3` | OpenAI-shaped (multipart) |
| OpenRouter, audio-in chat row | `google/gemini-3.5-flash`, `~google/gemini-flash-latest`, `openai/gpt-audio` | OpenAI-shaped (inline audio) |
| Google Gemini | `gemini-2.5-flash`, `gemini-3.5-transcribe` | Gemini (inline audio) |

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
- **A live take stops being live when the take stops.** Segments still in flight
  when the user taps are awaited before the take is closed, the segment that was
  being recorded is sent as the last one, and nothing is published after the
  take settles.
- **Live dictation needs a recorder that can be restarted, not one that
  timeslices.** The live path builds a fresh `MediaRecorder` per segment and
  stops it, so the browser writes each segment as a complete file; it never
  calls `recorder.start(ms)`, whose only effect is to cut the byte stream into
  fragments that no decoder can read.
- **A provider that wants a whole file gets one.** A segment is a valid
  container on its own, byte-for-byte what this page uploads, so the same
  `/audio/transcriptions` and Gemini call paths serve it; a model that cannot
  handle short audio is the reason the switch exists.
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
  counts the words as they land, says when a segment failed, and names what
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
  suggests — and routes a model that *can* hear to the endpoint that accepts it
  rather than dropping it. See "Two OpenAI-shaped routes" above.
- **Both of OpenRouter's catalogs are read for OpenRouter.** Its transcription
  slice serves the purpose-built speech-to-text rows and its chat slice is where
  its Google models live, because upstream files a Google Gemini row under
  `output_modalities: ["text"]`. Reading only the transcription slice is what
  made dictation offer no Google chat model at all on that connection —
  "Google models are not available on OpenRouter" — while the models themselves
  were always able to transcribe.
- **A model is classed as Gemini only when it really is one** (its provider, or
  a `google/…` slug). Classifying by id substring looked harmless and was not:
  it swept up dozens of OpenRouter entries whose names merely contain
  "gemini", which both sent them to the wrong endpoint and — because the Gemini
  family is on the candidate list by definition — filtered every other
  provider's models out of the list, so dictation appeared to offer Google
  models only.
- **Both of Gemini's transcript shapes are read.** `parts[].text` for the
  general models and `parts[].audioTranscription.text` for the dedicated
  transcription models (`gemini-3.5-transcribe`), whose `text` is empty.
  Parsing only the first reported a successful transcription as "the provider
  returned no transcript".
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
- **A remembered model is not overridden by the fast catalog pass.** The page
reads its catalog in two passes — the project's own records first (the fast
first paint), then the providers' live lists. A model that lives on a provider
connection is absent from the first pass, so letting that pass resolve a
fallback left the picker on the project's default and the `onlyIfEmpty` live
pass then declined to correct it — the model reverted on every visit and looked
like it had never saved. The "already chosen" flag the live pass consults is
now written **only** by an explicit pick, so a fast-pass fallback never counts
as one.
- **Every write carries the whole record, and writes are serialized.** The
`dictation` record holds several fields (the model pair, `live`, the two
per-run hints) and `PUT /api/settings/app` merges shallowly, so each change
has to send the full record. Two changes made close together used to race:
both read the same "before", and the slower response landed last carrying the
older field — the first change appeared to be forgotten, most visibly the
model. The page now keeps the pending record and chains each write behind the
previous one, so the last thing the user changed is what survives.
- **There is no request-shape control.** The dialect a model is sent with is a
  property of its provider connection *and* of what the provider reports about
  the model, and the shapes are not interchangeable — a Gemini connection
  pointed at `/audio/transcriptions`, or an OpenRouter connection pointed at
  `/v1beta/models/…:generateContent`, is a 404. The page reports the shape it
  will use instead of letting it be set, and echoes it back with the request so
  the read-out and the call cannot disagree.
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
  `openai-compatible`) and the provider's own message is kept because it is the
  only thing that says *why* (`upstream 401 Unauthorized`), so one red line
  names both the cause and the connection to fix. There is no follow-up
  instruction line: the picker and the Refresh button sit directly above it.
  Those rows are missing from the picker; the providers that did answer still
  are not.
- **Dictation is not a security boundary or a background service.** It records
  only while the button says it is recording, and it stops the microphone on
  unmount.
- **The Dictation page works without an active project** — it adopts the first
  registered project (and names it in the Model group's title) so the model
  picker is not empty after a cold start or a PWA launch. With no registered
  project at all, it says so and only Copy is available on a transcript.

## Implementation notes

- `src/transcribe.js` — the request families, the response parsers, the family
  inference, and the candidate filter. Pure: multipart bodies and the inline
  JSON bodies are built by hand (not with `FormData`) so the wire shape can be
  asserted byte-for-byte in a test. `audioChatModel` decides the chat route for
  an audio-input row that has no `/audio/transcriptions` entry, and
  `audioFormatFor` names the container the way the `input_audio` field wants it
  (`webm`, not `audio/webm;codecs=opus`). `usageFromResponse` reads the
  provider's token report for every family; `parseTranscribeResponse` carries it
  through as `usage` (or `null`) and reads both of Gemini's transcript shapes.
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
  in it. The dictation catalog reads **both** slices for OpenRouter: that one
  for the purpose-built transcribers, and the chat slice for the audio-input
  rows (every Google Gemini model), which is where a model that can hear but
  has no `/audio/transcriptions` entry is reachable at all.
- `src/server-handlers-transcribe.js` — `GET /api/ai/transcribe/models` and
  `POST /api/ai/transcribe`. Resolves the model through the shared
  `resolveModel`, injects the credential server-side, applies the 60s deadline,
  prices the provider's usage report, and maps typed codes onto HTTP statuses.
  Mounted before the generic
  `/api/ai/` branch in `src/http-server.js`. The catalog merges the project
  models with the live lists — read as the provider's *transcription* slice
  (cached under its own key so the chat picker and this one cannot serve each
  other's rows), plus the *chat* slice for OpenRouter, where its Google models
  live; `?live=0` serves the project models alone (the page's fast first paint)
  and `?refresh=1` bypasses the live cache.
  `POST /api/ai/transcribe` answers `{ text, model, kind, bytes, durationMs,
  usage, cost }` — `usage: null` and `cost.known: false` when the provider
  reported nothing. The route is decided from the live capability report the
  catalog selected on, read back from the same cache `resolveModel` prices from
  (a live row is rebuilt from its id and provider, so the report is not on it);
  a `kind` echoed by the picker wins over that re-derivation. The optional
  `chatId` on the body is what makes a run **attributed**: the handler calls
  `messages.addChatCost(projectDir, chatId, cost.total)` for a known, positive
  cost, which moves the chat row's `total_cost` / `cost_known_count` and the
  registered project's total in one transaction — the same counters
  `appendMessage` maintains. It is best-effort (a chat deleted mid-take must not
  turn a transcript into an error) and it never runs for an unknown or zero
  cost, so `--` runs stay out of every total.
- `src/chatdb.js` — `addChatCost(projectDir, chatId, amount)`, the second writer
  of the persisted cost counters and the only one that does not write a message.
  It is exported on `src/messages.js` as `addChatCost` for the transcribe
  handler.
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
  `createLiveSegments`, `createSegmentRecorder`, `liveTakeCost`,
  `liveDictationEnabled`), and the transcript action set. `transcribeAudio` forwards an optional `chatId`, which
  is what makes a run attributed to a chat. Pure enough to unit-test: the join,
  the slot-ordering rules and the take's summed price are decided from values
  alone, which is why they are not asserted through a recorder.
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
  them, so a pin means the same thing on both surfaces. `MicButton` records a
  live take by rotating `MediaRecorder` — via `createSegmentRecorder` — exactly
  when the app-level choice says live; with live off it keeps the
  one-request-on-stop path (one recorder, one request when the button is tapped
  a second time). It never hands the recorder a timeslice, and it sends
  `chatId` on every request, which is what attributes the run to the chat; the
  page does not send one.
- `frontend/src/components/chat/Chat.jsx` — owns the chat's status line, so the
  microphone takes an `onStatus(message, state)` callback and writes its
  progress and failures there (`Chat.jsx` → `setStatus`). It also owns the
  draft, so a live segment is written through
  `onTranscript(text, { live: true })`
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
- **"Is this connection OpenAI-shaped?" has one answer.** The list of
  OpenAI-shaped providers lives in [src/providerShapes.js](../../src/providerShapes.js),
  the one leaf module every consumer reads (it originally existed so this
  module and the since-removed image module could not disagree).
  It names the eight shipped OpenAI-shaped providers (`openai-compatible`,
  `openrouter`, `azure`, `mistral`, `groq`, `deepseek`, `ollama`,
  `github-copilot`). `gemini` is absent because it speaks its own per-model
  `generateContent` action path; `anthropic` is absent because it speaks the
  Messages API. The list used to be copy-pasted per module, and this copy had
  grown an extra `anthropic` entry — which did not affect the multipart default
  (a non-Gemini provider already falls through to it) but *did* let
  `audioChatModel` reroute a Claude row to an OpenAI `/chat/completions` URL
  that cannot exist. [scripts/test-provider-shapes.js](../../scripts/test-provider-shapes.js)
  pins the list and cross-checks each entry against its `ENDPOINTS` row.
- **Attribution is one extra write on the success path.** The handler only calls
  `messages.addChatCost` when the request carried a `chatId` *and* the priced
  cost is known and positive, so an unpriced run (`--`), a page run (no
  `chatId`) and a failed run all leave every total untouched. It is wrapped in a
  `try`/`catch`: the upstream call is already paid for, and a chat deleted
  mid-take must not turn a transcript into an error.

### Tests

`npm run test:dictation` runs everything below except the two fixtures, which
print a URL and stay up instead of exiting (`test-dictation-ui.mjs` is only
syntax-checked there; `test-dictation-chat.cjs` needs a debug Chrome of its own
and runs by hand). `test-dictation-chat.cjs` runs as part of `test:dictation`:
it starts its own browser target and exits on its own.

```bash
node scripts/test-dictation.js        # request/response shapes, helper rules,
  # the live-take join and slot ordering, the take's summed price, the
  # audio-chat route decision and format naming, both Gemini transcript shapes,
  # the loading wording and the busy phase, and the app-store allowlists the
  # choice needs
node scripts/test-dictation-http.mjs  # the real serve handlers, mock upstream —
  # including the inline-audio chat route, the `audioTranscription` shape, and
  # the attribution of a chat-attributed run to the chat and project totals
node scripts/test-dictation-page.mjs  # the page rendered against a fake API
node scripts/test-dictation-catalog-live.mjs  # the candidate filter and the
  # route decision against the two real OpenRouter catalogs, replayed from
  # scripts/fixtures/dictation-openrouter-models.json (chat) and
  # -stt-models.json (transcription); `--record` refreshes both from the live
  # API. It asserts every audio-input chat row is routed to /chat/completions
  # (and a `:batch` or name-hinted row is not), and that the Google Gemini rows
  # dictation now offers are absent from the transcription slice — which is why
  # both slices are read.
node scripts/test-dictation-ui.mjs    # a browser fixture: prints a URL, or
  # `--write <dir>` emits it to serve statically. Its fake recorder is
  # stop-driven (one recorder per segment), and it counts what it was asked
  # for, so the composer-mic scenario shows the real rotation: leave the mic on
  # past two 3-second segments and the draft fills in as they are answered
  # (`fixture.recorders` grows by one per rotation, `fixture.startArgs` stays
  # zero-argument). The mixed scenario carries both routes at once (an
  # `openai-audio` Google row beside `openai-compatible` transcribers), so the
  # picker's "Sends as" line can be seen saying `OpenAI chat` for one and
  # `OpenAI-shaped` for another.
node scripts/test-dictation-chat.cjs  # the composer mic inside the real
# ChatView (needs debug Chrome; see CDP_URL below): the model comes from the
# app store, the draft is persisted, the cost is attributed, a live take is
# recorded by *rotating* (several segments, stitched in speaking order, cost
# settled as their sum), no take ever asks the recorder for a timeslice, and
# a tap that is still resolving the model names that wait in the chat's line
# (`Preparing dictation…`) while the button takes *none* of the loading
# affordances — no spinner, no `aria-busy`, no `Working…`, since nothing is
# being transcribed yet — *after* it has outlasted the delay, with the fixture
# holding the settings read for one check and holding it for nothing for the
# counter-check, so a fast tap proving it says nothing at all is watched too.
# The fixture's fetch is fully stubbed, so nothing reaches a provider.
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
all, a tap with nothing configured reports why in that same line without
opening the microphone, and a live take is a sequence of whole recordings —
one request per rotation, spliced in speaking order, settled with the sum of
their prices, with the partial last segment still sent. The mic's loading state
is pinned to the transcription request on both sides of `MIC_WAIT_DELAY_MS`: the
settings read held slow writes `Preparing dictation…` to the chat's line while
the button keeps its glyph (no spinner, no `aria-busy`), and held for nothing
the same tap says nothing at all. It also pins the live take's *settle* as one
of those requests: with the transcription held, stopping a rotating take leaves
the spinner, `Working…` and `aria-busy` on the button and `Transcribing…` in the
chat's line until the last segment answers, and both are gone once it settles.
It needs a debug Chrome (`CDP_URL`, default `http://127.0.0.1:9222`), like the
model-picker browser tests.

The live path is covered on both sides: `test-dictation.js` decides the join,
the seam, the slot ordering and the rotation itself (with a fake recorder and
fake timers), and `test-dictation-chat.cjs` drives the real button in a real
browser, where the rotation runs on its own clock and the segments are answered
by a stubbed provider.

## Related

- [AI client](ai-client.md) — the chat proxy this endpoint sits beside.
- [Usage metrics](usage-metrics.md) — the pricing table a run's cost is resolved from.
- [Model picker](model-picker.md) — where the models come from.
- [App and project settings](app-and-project-settings.md) — the `dictation`
  app-level key and the project `models` array.
- [Composer tool buttons](composer-tool-buttons.md) — hiding the composer
  microphone with the `dictationButton` switch.
- [Routing](routing.md) — the `#/settings/dictation` route (and its `#/dictation` alias).
- Source: [`src/transcribe.js`](../../src/transcribe.js),
  [`src/server-handlers-transcribe.js`](../../src/server-handlers-transcribe.js),
  [`src/ai-endpoints.js`](../../src/ai-endpoints.js) (`listTranscriptionModels`),
  [`frontend/src/dictation.js`](../../frontend/src/dictation.js),
  [`frontend/src/components/DictationPage.jsx`](../../frontend/src/components/DictationPage.jsx).
