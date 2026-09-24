// mouaif web — the CLI modal's command suggestions.
//
// Why the row exists: `.cli__prompt` is a plain <input> with no history and no
// completion, and at 0.82rem in a sheet the soft keyboard already covers much
// of, the letters of the *previous* command are the ones a phone user is least
// able to read back. Re-typing `npm run test:cli` character by character is the
// exact cost this removes.
//
// The list is the session's own output plus the project's own files. Nothing is
// guessed and nothing is sent: a chip only rewrites the input field, so **Enter
// is still the user's decision** — the same discipline the inspector's value
// suggestions follow.
//
// Two sources, both already on the client:
//
//   * the shell's echo lines (`❯ ls -la` in that output — the prompt mark the
//     modal prints before each command), which is the session's history and
//     needs no round trip;
//   * the project's top-level entries from `GET /api/files`, the endpoint the
//     file editor already browses with. Names only, one level deep: a
//     suggestion row is a shortcut, not a second file browser.
//
// Nothing here touches Preact or the DOM, so it is unit-testable directly (see
// scripts/test-cli-suggest.js).

// MAX_SUGGESTIONS — chips shown. Above that the row stops being a shortcut and
// becomes a list to read; the field is still right there for anything else.
export const MAX_SUGGESTIONS = 7;

// MAX_HISTORY — how many of the session's own commands are considered. Newest
// wins when two entries would produce the same chip.
const MAX_HISTORY = 40;

// The prompt mark the modal prints before each command line.
const PROMPT_MARK = '❯';

// commandFromEchoLine(line) — the command a `❯ …` echo line recorded, or ''.
//
// The echo line *is* the command (the modal writes it before writing the
// command to the shell), so a trailing shell prompt or program output is not
// part of it: only the line's own leading mark and blank space are stripped,
// plus a trailing carriage return from a CR-terminated line.
export function commandFromEchoLine(line) {
  const text = String(line == null ? '' : line).replace(/\r$/, '');
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(PROMPT_MARK)) return '';
  return trimmed.slice(PROMPT_MARK.length).trim();
}

// historyFromOutput(output) — the session's commands, newest first, de-duped.
//
// `output` is the modal's rendered screen (`CliScreen.render()`), i.e. the text
// the user is looking at, so the history is exactly what the reader can scroll
// back to. A bare Enter (an empty line, which is a meaningful answer to a
// prompt) records no command and is skipped — offering it as a chip would offer
// nothing.
export function historyFromOutput(output) {
  const lines = String(output == null ? '' : output).split('\n');
  const seen = new Set();
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < MAX_HISTORY; i--) {
    const cmd = commandFromEchoLine(lines[i]);
    if (!cmd || seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

// nameTokens(entries) — what a directory listing contributes to the row: each
// entry's name, with a trailing slash on a directory. An entry from
// `GET /api/files` is `{ name, relPath, type }`.
function nameTokens(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.name !== 'string' || !e.name || /[\n\t]/.test(e.name)) continue;
    // Hidden dot-entries are real files (the file editor opens them), but they
    // are not what a first suggestion chip should be: `.gitignore` and friends
    // are noise beside the folder the user is working in.
    if (e.name.startsWith('.')) continue;
    out.push(e.type === 'dir' ? e.name + '/' : e.name);
  }
  return out;
}

// suggestionsFor({ draft, history, entries }) → [{ text, kind, rank }]
//
//   * `draft`   — what is in the field now; '' means "the whole list, newest
//                 and most relevant first";
//   * `history` — newest first, as `historyFromOutput` returns it;
//   * `entries` — the project's top-level listing as `GET /api/files` returns
//                 it, or null when it has not been fetched (a fetch that has
//                 not happened invents no rows).
//
// With a draft the row narrows to candidates the draft could *continue* or
// contain, prefix matches first. A candidate identical to the draft is dropped:
// tapping it would change nothing, which is worse than an empty row.
export function suggestionsFor(input) {
  const opts = input || {};
  const draft = String(opts.draft == null ? '' : opts.draft).trim();
  const needle = draft.toLowerCase();
  const candidates = [];

  const consider = (text, kind) => {
    if (!text || text === draft) return;
    if (needle && text.toLowerCase().indexOf(needle) === -1) return;
    if (candidates.some((c) => c.text === text)) return;
    // Prefix matches come first — `npm r` should offer `npm run …` before the
    // file that merely happens to contain those letters.
    const rank = needle && text.toLowerCase().startsWith(needle) ? 0 : 1;
    candidates.push({ text, kind, rank });
  };

  for (const cmd of Array.isArray(opts.history) ? opts.history : []) consider(cmd, 'history');
  for (const name of nameTokens(opts.entries)) consider(name, 'file');

  // Stable sort: inside a rank, the source order (recent history, then the
  // listing's own dirs-first order) is kept.
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates.slice(0, MAX_SUGGESTIONS);
}
