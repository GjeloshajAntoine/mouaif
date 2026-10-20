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

The page has three controls:

| Control | What it does |
| --- | --- |
| **Mode** | `Off` (default) never reviews. `On demand` only reviews when you tap the review button. `Always` reviews every shell command the assistant proposes, before its approval card is answered. |
| **Model** | The reviewer. It is the **same model picker the rest of the app uses** — the chat head, the agent editor, the subagent defaults and dictation all render it: your project's models plus every configured provider's live catalog, the same pinned and recent rows, the same refresh action. Picking a row saves it (and if Mode was `Off`, switches Mode to `On demand` so the model is ready right away). |
| **Prompt** | What the reviewer is asked (its system message). Blank uses the built-in instruction: describe the effects, then answer with one verdict line — `SAFE`, `CAUTION` or `DANGER`. Saved as you type. |

There is **no default reviewer**. A review is a request on your account, so nothing is sent until a model is picked; the status line says *No review is sent yet: pick a model below* until then.

If the saved model's provider connection is later removed, the picker still shows the saved pair (and marks it unavailable inside the sheet) and the page warns — the value starts working again the moment the connection is added back.

The page is laid out like its sibling pages (File tool options, Web preview): a mode row, a model row, a prompt row, each a card with a bold title, a one-line description, and its control underneath. The mode and the model save immediately (both are closed choices). The prompt saves as you type, debounced, like the agent editor's instructions. Every save writes the whole `shellReview` object: the server keeps it as one value, so saving a prompt cannot clear the model.

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
