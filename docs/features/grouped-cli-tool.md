# Grouped CLI tool — run many shell commands in one call, some in the background

## Overview

`group_cli` is the batch counterpart of the [shell tool](shell-tool.md). One call carries an ordered list of commands, runs each one exactly like a `shell` call (same working folder, same interpreter, same output cap), and returns a per-entry result instead of stopping at the first failure. An entry marked `"async": true` is **started in the background** instead of awaited: the call returns immediately with a pid and a log path, the command keeps running, and its output is appended to a log file under `.mouaif/logs/` that the model can read later with `read_file`.

Like [grouped file tools](grouped-file-tools.md), it is an ordinary native tool: same card, same authorization card, same `tool_call` / `tool_result` / `shell_output` events.

## Usage

In a chat, ask for a sequence — "run the build, then the tests, and tell me what failed" — and the model can do it in one call instead of three. The call looks like this:

```json
{
  "commands": [
    { "cmd": "git status --short", "label": "status" },
    { "cmd": "npm run build" },
    { "cmd": "npm test" }
  ]
}
```

The result reports every entry:

```text
1. status
    ✓ · 42ms
    M src/tools/shell.js

2. npm run build
    ✓ · 8120ms
    ...

3. npm test
    ✗ exit 1
    ...
1 succeeded · 2 failed · 8410ms
```

### Background (async) commands

Mark an entry `async` — or pass `"async": true` on the whole call — to start it and return straight away:

```json
{
  "commands": [
    { "cmd": "npm run dev", "label": "dev server", "async": true },
    { "cmd": "curl -s localhost:5173 | head -20" }
  ]
}
```

The first entry comes back as `{ "async": true, "status": "running", "pid": 1234, "logPath": ".mouaif/logs/…log" }`; the second runs while it is still up, so a server can be started and probed in one call. The background command's stdout and stderr are appended to `logPath`, and the file ends with a `[mouaif] exit <code> after <ms>` line once it finishes. `read_file` reads the log like any other file.

Background commands are exempt from the batch time budget, and the synchronous entries after them are not slowed down by them: the batch only waits for the entries that are not `async`.

### Arguments

| Argument | Meaning |
| --- | --- |
| `commands` | Required. 1–50 entries, run in order. |
| `commands[].cmd` | The command. `command` is accepted as a synonym. |
| `commands[].label` | Optional short name, echoed in the result and shown on the card. |
| `commands[].shell` | Optional interpreter for this entry, same values as the shell tool's `shell`. |
| `commands[].timeoutMs` | Optional per-entry timeout, 1 ms – 10 min. |
| `commands[].async` | Start this entry in the background. |
| `timeoutMs` | Optional whole-batch time budget for the synchronous entries. A clamped default applies (5 min), and the project's shell timeout ceiling caps it. |
| `shell` | Optional interpreter for every entry that does not name its own. |
| `async` | Start **every** entry in the background. |
| `parallel` | Accepted and ignored today: entries always run in order. |

## Behavior

- **Order is the array's order, and it is sequential.** A batch is usually a dependent chain (`build`, then `test`), so a silent parallel default would reorder results the caller cannot see. Async entries are how a caller asks for overlap.
- **A failure is data.** A non-zero exit, a missing command, a bad `shell` value or a timeout is reported on that entry only; the batch continues, and the model can retry just the failed entry.
- **Three bounds.** 50 entries, a batch time budget for the synchronous entries, and the shell tool's per-stream output cap. A background command's log stops growing at 4 MB and says so.
- **One live preview, per entry.** While the batch runs, each output chunk is streamed to the chat card as a `shell_output` frame carrying the entry's index, label and command, so the card shows which command produced the text.
- **Background logs are `mouaif`'s, not the project's.** They live in the project's `.mouaif/logs/` directory, which is mouaif's own scratch space and is normally gitignored — a background command never litters the project with log files. A project directory that cannot be written to still runs the command; the result then names no log.
- **Authorized as one `mouaif` call.** See below.

## Authorization

`group_cli` is a leaf of the **mouaif** family in the tools tree (`frontend/src/toolGroups.js`), next to `get_settings`, `restart_app` and `list_features`:

| Gate | Leaves |
| --- | --- |
| `mouaif` | `get_settings`, `update_settings`, `list_projects`, `get_app_info`, `restart_app`, `list_features`, `group_cli` |

So the ordinary family rules apply: `tools.mouaif: { "mode": "off" }` hides the tool from the model and rejects a forged call with `ETOOL_DISABLED`; `allow` runs a batch without asking; a per-leaf override (`tools.group_cli`) tightens or loosens just this tool.

Two details are specific to a batch:

- **The approval card lists every command**, numbered, with `[background]` on the entries that will be detached — the user is approving all of them, not just the first.
- **An `allowlist` must match every command.** One listed command never vouches for the rest of the batch (the same rule grouped file edits use for paths).

Note that a `mouaif` family `allow` — including one earned by choosing **Always allow** on any mouaif call — also lets the assistant run a command batch without asking. Turn the batch tool off on its own with a `tools.group_cli` leaf override if you want the family open and command batches gated.

## Related

- [Shell tool](shell-tool.md) — the single-command tool this batches.
- [Grouped file tools](grouped-file-tools.md) — the same batch contract for reads and edits.
- [Live tool preview](live-tool-preview.md) — how the streamed output reaches a returning chat.
- [Tool authorization](tool-authorization.md) — Off / Ask / Allow for every tool.
- [Tool groups](tool-groups.md) — the family this tool belongs to.
