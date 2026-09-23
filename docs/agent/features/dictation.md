# Dictation — implementation notes

> Agent-facing reference for [`docs/features/dictation.md`](../../features/dictation.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

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
  OpenAI-shaped providers lives in [src/providerShapes.js](../../../src/providerShapes.js),
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
  that cannot exist. [scripts/test-provider-shapes.js](../../../scripts/test-provider-shapes.js)
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
