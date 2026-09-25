# Dictation

## Overview

Dictation turns speech into text using a model the user picks, and hands that text to the app rather than sending it. It has two surfaces: a **Dictation** page under Settings that records, transcribes and shows an editable transcript, and a **microphone button in the chat composer** that transcribes *while the user speaks* and grows the draft as the words arrive. The provider credential never reaches the browser: the recording is posted to `POST /api/ai/transcribe` and the server performs the upstream call.

## Usage

### The Dictation page

1. Open **Settings → App defaults → Dictation** (or `#/settings/dictation`).
2. Pick a **dictation model** (a model from the active project or one the connected providers offer) under **Dictation model**. The route it will be sent with is shown underneath, read-only. There is usually nothing to pick: a remembered model, a lone candidate, or a lone row whose name says it transcribes is selected for you.
3. In the **Test** card below, tap **Record**. The timer and level meter confirm the microphone is live. Recording stops on the second tap, or automatically at 2:00.
4. Tap **Transcribe**. The transcript appears in an editable field, and the line under it reports the run — model, size, duration, and **what it cost**.
5. Choose what happens to it: **Copy**, **Insert in chat** (fills the newest chat's draft), **Send to chat**, or **Clear**.

Optional per-run hints sit under the picker, one row each:

- **Live transcription** — the composer microphone transcribes while you speak. On by default; off makes a chat take behave like this page (record, stop, one request).
- **Language** — an ISO-639-1 or BCP-47 code (`en`, `fr`, `de`), passed to the provider so it biases decoding instead of guessing.
- **Vocabulary hint** — names and jargon the provider should expect (`mouaif, MediaRecorder, SSE`).

### The composer microphone

Inside a chat, the microphone button dictates **as you speak**. The take is cut into 3-second **segments**, each a complete recording, and every finished segment is posted as it arrives — so the transcript appears in the draft at the caret while the take is still running. Nothing is sent: dictation produces a draft, and sending stays a user decision.

The chat's status line under the composer is the live indicator (`12 words so far — tap the mic to stop.`), the button's tooltip carries the running clock (`Stop dictation (0:14)`), and the second tap closes the take and reports it (`dictation added`, plus the run's cost when it is priced).

With **Live transcription** off, the composer mic does one recording and one request, producing one transcript when the button is tapped a second time. Turn it off for a model that bills per minute or rejects a short recording on its own.

The model is resolved **before** the microphone opens, so a chat with no dictation model configured reports the reason in that same status line — `No dictation model yet — Open Settings → App defaults → Dictation to pick a dictation model.` — with nothing recorded. Everything the button does or fails to do (recording, transcribing, a provider rejection) is written there too, because the button's own `title` is a hover affordance a phone does not have.

The button itself can be hidden with **Settings → App defaults → Chat defaults → Dictation microphone in the composer** (`dictationButton`, on by default). That switch only decides whether the row draws the button — the dictation page, the remembered model, and the endpoint are untouched. See [Composer tool buttons](./composer-tool-buttons.md).

### What a run cost

A transcription is billed work, so both surfaces account for it:

- the **Dictation page** ends its "Last run" line with `cost $0.00055`;
- the **composer microphone** appends the figure to the chat's status line (`dictation added · $0.00055`) and attributes the priced run to the chat, so the header Total, the chat list row, and the project total all move by it;
- a **live take** reports nothing while it runs — each segment is a partial run — but settles with the sum of its segments' prices once they have all answered.

The number is resolved server-side with the same pricing table the chat uses, so a per-model override in `.mouaif.json` applies here too. See [Usage metrics](usage-metrics.md). `--` means *unknown*, not free:

| Situation | Cost line |
| --- | --- |
| the provider reported tokens and the model has a price | `$0.00055` |
| the provider reported no tokens (`whisper-1` bills per minute and answers with the transcript alone) | `--` |
| no pricing record for the model anywhere | `--` |

A run taken on the **Dictation page** belongs to no chat and stays point-of-use only. A run whose cost is unknown adds nothing to any total anywhere.

### Choosing from the list

A connected provider's catalog is a chat catalog: hundreds of rows, rendered provider by provider and alphabetical within each — except on a provider that publishes a separate transcription catalog (OpenRouter's speech-to-text rows), where the list *is* that slice. Two things keep the list usable:

- **Recommended** — a short section at the top of the sheet holding the rows worth reaching first: rows the provider reports as producing transcripts, then ids that say they transcribe (`whisper-*`, `voxtral-*`, `parakeet-*`), then rows the provider reports as taking audio input, then Gemini models. It only appears on the unfiltered list.
- **A default worth adopting.** The remembered model wins; failing that, a single candidate, or a single row whose name says it transcribes, is adopted automatically. Two `whisper-*` rows from two providers leave the picker asking, because a wrong guess is a provider error, not a cosmetic surprise.

**Pinned** and **Recently used** come from the same places the chat picker uses, so a model pinned while chatting is offered first when dictating. See [Model bookmarks](model-bookmarks.md).

## Behavior

- **Recording is capped at 2:00** and stops itself rather than dropping the tail.
- **The model list is the union of two sources**: the project's `models` and the connected providers' live catalogs, filtered to the rows that can plausibly transcribe. A project record for an id wins over the live row for it. A fresh install therefore works with no setup — connecting a Gemini key offers `gemini-2.5-flash`.
- **A provider that cannot transcribe a row is not offered it.** The catalog trusts what the provider reports about a model's output over what its name suggests, and routes a model that *can* hear to the endpoint that accepts it rather than dropping it.
- **Nothing is preselected when the choice is real.** A lone candidate, or a lone row whose name says it transcribes, is adopted; with two of either the picker asks.
- **The choice is remembered app-wide**, and written back on every change — including clearing it. That is what makes the composer microphone and a later visit agree with the page.
- **One unreachable provider does not empty the list.** Its failure is reported with the provider's own message, named as Settings names the connection, and the rows from the providers that did answer are still offered.
- **Failures name their cause.** A rejected key surfaces the provider's own message with HTTP 401, an unreachable provider is 502, a stalled one is 504 after 60s, and a recording that is too long is 413.
- **Every wait is reported** on the control that was tapped and beside the thing being waited on: a spinner and `aria-busy` on the catalog read-out, the **Transcribe** button, and the composer microphone, with the same words for a screen reader. A model resolve before the microphone opens gets a sentence (`Preparing dictation…`) only after it outlasts 400 ms, since a healthy connection answers inside a frame.
- **Nothing is auto-sent.** The composer hand-off fills a draft; the dictation page fills the newest chat's draft.
- **Dictation is not a security boundary or a background service.** It records only while the button says it is recording, and it stops the microphone on unmount.
- **The Dictation page works without an active project** — it adopts the first registered project so the model picker is not empty after a cold start. With no registered project at all, it says so and only Copy is available on a transcript.

## Related

- [AI client](ai-client.md) — the chat proxy this endpoint sits beside.
- [Usage metrics](usage-metrics.md) — the pricing table a run's cost is resolved from.
- [Model picker](model-picker.md) — where the models come from.
- [Model bookmarks](model-bookmarks.md) — pinned and recent models.
- [App and project settings](app-and-project-settings.md) — the `dictation` app-level key and the project `models` array.
- [Composer tool buttons](composer-tool-buttons.md) — hiding the composer microphone with the `dictationButton` switch.
- [Routing](routing.md) — the `#/settings/dictation` route (and its `#/dictation` alias).
