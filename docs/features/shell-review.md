# Shell review — a second model reads a command before it runs

## Overview

The shell tool can run any command in the project, and its authorization card asks *you* whether a command may run. That card answers "may this run?"; it does not answer "what does this actually do?". On a phone, `rm -rf dist .env && git clean -xdf` is easy to approve and hard to read at a glance.

Shell review adds an optional second opinion: you pick **one model** (its own provider and model, independent of the chat's model) and **one prompt**, and that model reads a proposed command and reports its effects with a `SAFE`, `CAUTION` or `DANGER` verdict. The verdict appears on the approval card, above the decision buttons, and in the chat's review sheet.

The reviewer is **display-only**:

- it cannot run, approve, deny or modify anything, and it never answers the approval prompt for you;
- it is not part of the chat: no message row is written, the chat model never sees the verdict, and there is no tool the model can call to ask for a review;
- if it cannot answer, the card simply has no review section — a reviewer that failed is not evidence that a command is safe or unsafe.

## Usage

### 1. Configure a reviewer

Shell review has **its own page**: **Settings → Project settings → Shell review**, or straight to `#/settings/project/shell-review?projectDir=…`. The project page carries a one-line link row that names the current choice (*off*, *no model yet*, or `always · <model id>`).

The page has four inputs:

| Input | What it does |
| --- | --- |
| **Mode** | `Off` (default) never reviews. `On demand` only reviews when you tap the review button. `Always` reviews every shell command the assistant proposes, before its approval card is answered. |
| **Browse catalog** | The fast path: the provider-qualified picker over the project's models plus every configured provider's live catalog. Picking a row fills both fields below and saves. |
| **Provider** | The provider connection the reviewer runs on. Only connections configured in Settings → Providers are listed. A stored provider whose connection was removed stays selectable and is marked *(not configured)* — the page never silently rewrites the id you saved. |
| **Model id** | The exact model id, as a plain text field with the chosen provider's live catalog as suggestions. This is the input for a model the picker does not list: a live-catalog slug, a local `llama.cpp` alias, an Azure deployment name. |
| **Prompt** | What the reviewer is asked (its system message). Blank uses the built-in instruction: describe the effects, then answer with one verdict line — `SAFE`, `CAUTION` or `DANGER`. |

There is **no default reviewer**. A review is a request on your account, so nothing is sent until both the provider and the model id are filled in; the status line says *No review is sent yet* until they are, and *No connection is configured for …* when the chosen provider has no connection.

**Check model** sends one cheap test prompt to the named pair (`POST /api/ai/test`) and reports whether it answered — worth doing once before every command in the project starts paying for reviews.

The mode and the catalog pick save immediately. The provider, model id and prompt are edited locally and committed with **Save model** / **Save prompt**, or when the field loses focus, so a half-typed model id is never stored. Every save writes the whole `shellReview` object: the server keeps it as one value, so saving a prompt cannot clear the model.

### 2. Review a command on demand

Open the chat's wrench (**Tool settings**) popup and tap **Review a command**. The review sheet opens with the composer draft already in its command field (type or paste a command into the composer first to seed it). Then:

1. edit the command;
2. tap **Review** — the sheet sends that text to the configured reviewer and nothing else. It never runs the command;
3. read the verdict block, with the reviewer's model and the review's cost underneath;
4. optionally edit the **Review prompt** and tap **Save prompt** to reuse that wording next time;
5. if no reviewer is configured, the sheet says so and links straight to the Shell review page.

With `When` set to `On demand` this is the only way a review happens.

### 3. Read an automatic review

With `When` set to `Always`, every shell command the assistant proposes is sent to the reviewer before the approval card is answered. The verdict appears in the card's **Second opinion** block, above the *Once / Session / Always / Deny* buttons. The command still runs only when you approve it.

A review that arrives after the card mounted fills in place, so you never see a second card. A page reload while the card is open still shows the verdict, because it is also attached to the server's pending approval request.

## REST

| Route | Purpose |
| --- | --- |
| `POST /api/tools/shell/review` | Review one command on demand. Body: `{ projectDir, cmd, cwd?, chatId? }`. |

```bash
curl -s -X POST http://127.0.0.1:5732/api/tools/shell/review \
  -H 'Content-Type: application/json' \
  -d '{"projectDir":"/home/me/project","cmd":"rm -rf build"}'
```

A successful review answers `200` with `{ ok: true, text, verdict, model, usage, cost, durationMs }`. An off or incomplete configuration answers `409` (`EREVIEW_OFF`, `EREVIEW_MODEL`), a missing command `400`, and an upstream failure `502` — all with the same body shape, so a client renders a failure the same way it renders an answer. When a `chatId` is given, the review's cost joins that chat's persisted total.

For the module surface, the wire event, delivery and dedupe rules, see the implementation notes that ship with the repository (`docs/agent/features/shell-review.md`).

## Related

- [Shell tool](./shell-tool.md) — the commands this reviews.
- [Tool authorization](./tool-authorization.md) — the gate that still owns "may this run?".
- [Tool popup](./tool-popup.md) — where the review button lives.
- [App and project settings](./app-and-project-settings.md) — project scope versus app scope.
