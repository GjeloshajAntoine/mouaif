// mouaif web — the CLI modal's command suggestions.
//
// Why the row exists: `.cli__prompt` is a plain <input> with no history and no
// completion, and at 0.82rem in a sheet the soft keyboard already covers much
// of, the letters of the *previous* command are the ones a phone user is least
// able to read back. Re-typing `npm run test:cli` character by character is the
// exact cost this removes.
//
// The list is the session's own commands plus the project's own files. Nothing
// is guessed and nothing is sent: a chip only rewrites the input field, so
// **Enter is still the user's decision** — the same discipline the inspector's
// value suggestions follow.
//
// Two sources, both already on the client:
//
//   * the commands this modal sent to the *shell* (see `rememberCommand`),
//     kept as a short list in the modal's state. It is deliberately not read
//     back from the screen: on a pseudo-terminal the screen also shows answers
//     typed to a program's prompt, and a hidden answer (`read -s`, `sudo`, an
//     npm one-time code) must never come back as a chip;
//   * the project's top-level entries from `GET /api/files`, the endpoint the
//     file editor already browses with. Names only, one level deep: a
//     suggestion row is a shortcut, not a second file browser.
//
// Nothing here touches Preact or the DOM, so it is unit-testable directly (see
// scripts/test-cli-suggest.js).

// MAX_SUGGESTIONS — chips shown. Above that the row stops being a shortcut and
// becomes a list to read; the field is still right there for anything else.
export const MAX_SUGGESTIONS = 7;

// MAX_HISTORY — how many of the session's own commands are kept. Newest wins
// when the same command is sent twice.
export const MAX_HISTORY = 40;

// rememberCommand(history, cmd, owner) → the next history (newest first).
//
// `owner` is who was reading stdin when the line was sent:
//
//   * 'shell'   — the shell's line editor (bracketed paste on, see
//                 `lineEditorState` in ./cliKeys.js): the line is a command;
//   * 'piped'   — a session with no pseudo-terminal, where nothing can prompt
//                 (stdin is not a TTY), so every line is a command;
//   * anything else — a program, or a pty whose shell never said: the line
//                 may be an answer, possibly a secret, so it is not kept.
//
// A blank line and a history expansion (`!!`, `!git`) are not kept either —
// the first offers nothing, the second is the shell's history, not a command.
// Returns the same array when nothing changes, so a state setter can skip the
// render.
export function rememberCommand(history, cmd, owner) {
  const list = Array.isArray(history) ? history : [];
  const text = String(cmd == null ? '' : cmd).trim();
  if (!text || text.startsWith('!')) return list;
  if (owner !== 'shell' && owner !== 'piped') return list;
  if (list[0] === text) return list;
  return [text].concat(list.filter((c) => c !== text)).slice(0, MAX_HISTORY);
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
//   * `history` — newest first, as `rememberCommand` keeps it;
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
