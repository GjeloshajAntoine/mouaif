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

In **Settings → Project settings → Shell review**, set three things:

| Control | What it does |
| --- | --- |
| **When** | `Off` (default) never reviews. `On demand` only reviews when you tap the review button. `Always` reviews every shell command the assistant proposes, before its approval card is answered. |
| **Model** | The provider-qualified model that reviews. Any project model or live-catalog model of a configured provider works. There is no default: the section says "Pick a model below" until you choose one. |
| **Prompt** | What the reviewer is asked. Blank uses the built-in instruction, which asks for the effects and then a single verdict line. |

Everything saves immediately — there is no Save button except for the prompt, which has its own **Save prompt** action because a PUT per keystroke would rewrite `.mouaif.json` dozens of times for one sentence.

### 2. Review a command on demand

Open the chat's wrench (**Tool settings**) popup and tap **Review a command**. The review sheet opens with the composer draft already in its command field (type or paste a command into the composer first to seed it). Then:

1. edit the command;
2. tap **Review** — the sheet sends that text to the configured reviewer and nothing else. It never runs the command;
3. read the verdict block, with the reviewer's model and the review's cost underneath;
4. optionally edit the **Review prompt** and tap **Save prompt** to reuse that wording next time.

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
