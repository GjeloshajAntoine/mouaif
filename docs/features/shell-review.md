# Shell review — review commands and auto-allow safe CLI calls on Ask

## Overview

The shell tool can run any command in the project, and its authorization card asks *you* whether a command may run when set to `Ask`. On a phone, `rm -rf dist .env && git clean -xdf` is easy to approve by accident, while routine read-only commands (`ls`, `git status`, `npm test`) are tedious to approve one by one.

Shell review uses **the same model as the rest of the app** (the active chat's model, or the project's model) and **one prompt** to read a proposed command, report its side effects with a `SAFE`, `CAUTION` or `DANGER` verdict, and — when **Auto-allow SAFE commands when CLI is on Ask** is enabled — automatically approve `SAFE` commands (`allow-once`) so they run immediately while `CAUTION` and `DANGER` commands still wait on the approval card.

## Usage

### 1. Configure shell review

Shell review lives at **Settings → Project settings → Shell review** (`#/settings/project/shell-review?projectDir=…`).

The page has a **Review model** picker and three review controls:

| Control | What it does |
| --- | --- |
| **Mode** | `Off` (default) never reviews automatically. `On demand` only reviews when you tap **Review a command** in the chat tool menu. `Always` reviews every shell command when the CLI is set to `Ask`. |
| **Auto-allow SAFE commands when CLI is on Ask** | Enabled by default when review is on. When the review answers `SAFE`, the pending `Ask` prompt is automatically approved (`allow-once`) and the command runs right away; `CAUTION`, `DANGER`, or a failed review still waits for your decision on the card. |
| **Prompt** | What the model is asked (its system message). Blank uses the built-in instruction: describe the effects, then answer with one verdict line — `SAFE`, `CAUTION` or `DANGER`. Saved automatically as you type. |

**Review model** follows the [model picker specification](./model-picker.md), including its compact chat-style trigger without extra descriptive text. It opens the shared model picker with saved project models and connected providers’ live chat catalogs. It includes the same app-wide **Pinned** and **Recent** sections, pin actions, search, and **Refresh models** action as the chat picker. Choose a separate reviewer or clear the choice with **Same as the chat**. Selection saves automatically together with the mode, prompt, and auto-approval setting; no configuration-file editing is needed.

### Thinking / reasoning

The **Review thinking level** control beside the model picker uses the same reasoning presets as agent and approval model selectors. Choices follow the selected model’s thinking descriptor. **Model default** clears the override. The choice saves automatically as `shellReview.thinkingLevel` and is applied to both on-demand and automatic reviews. Editing the review prompt preserves it.

### 2. Review a command on demand

Open the chat's wrench (**Tool settings**) popup and tap **Review a command**. The review sheet opens with the composer draft already in its command field:

1. edit the command;
2. tap **Review** — the sheet sends that text to the reviewer and nothing else (the sheet itself never runs the command);
3. read the verdict block, with the model and the review's cost underneath;
4. optionally edit the **Review prompt** and tap **Save prompt** to reuse that wording next time.

### 3. Automatic review and auto-allow on Ask

With **Mode** set to `Always` and the shell tool set to `Ask`, every proposed shell command is reviewed as soon as the approval prompt is reached:

- If **Auto-allow SAFE commands when CLI is on Ask** is enabled and the verdict is `SAFE`, the command is automatically approved (`allow-once`), runs immediately, and attaches the `Safe · Auto-allowed` review block to the shell card.
- If the verdict is `CAUTION` or `DANGER` (or auto-allow is unchecked), the verdict appears in the approval card's **Second opinion** block above the *Once / Session / Always / Deny* buttons, and the command waits for your decision.

## REST

| Route | Purpose |
| --- | --- |
| `POST /api/tools/shell/review` | Review one command on demand. Body: `{ projectDir, cmd, cwd?, chatId? }`. |

```bash
curl -s -X POST http://127.0.0.1:5732/api/tools/shell/review \
  -H 'Content-Type: application/json' \
  -d '{"projectDir":"/home/me/project","cmd":"rm -rf build"}'
```

A successful review answers `200` with `{ ok: true, text, verdict, model, usage, cost, durationMs }`. An off configuration answers `409` (`EREVIEW_OFF`), a missing command `400`, and an upstream failure `502` — all with the same body shape, so a client renders a failure the same way it renders an answer. When a `chatId` is given, the review's cost joins that chat's persisted total.

For the module surface, the wire event, delivery and dedupe rules, see the implementation notes that ship with the repository (`docs/agent/features/shell-review.md`).

## Related

- [Shell tool](./shell-tool.md) — the commands this reviews.
- [Tool authorization](./tool-authorization.md) — the gate that owns `Off / Ask / Allow`.
- [Tool popup](./tool-popup.md) — where the review button lives.
- [App and project settings](./app-and-project-settings.md) — project scope versus app scope.
