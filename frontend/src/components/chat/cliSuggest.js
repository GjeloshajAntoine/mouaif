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

// completeLocally(text, history, entries) → the completed text, or `null` when
// nothing matches.
//
// This is what Tab does now (see the CLI modal): completion happens in the
// <input> itself rather than on the shell's own readline line, so a phone user
// *sees* the result and never loses what they typed. The candidates are the same
// two client-side sources the suggestion row uses — the session's own commands
// and the project's top-level names — so it needs no round-trip and works where
// no pseudo-terminal could be allocated too.
//
// Two phases, most-specific first:
//
//   1. **the line** — a command from this session's history that starts with
//      what is on the line (`npm ru` → `npm run test:cli`, `git ch` → the last
//      `git checkout …`). A command equal to the line is not a completion.
//   2. **the word before the caret** — a project entry that starts with the
//      line's trailing word, with the rest of the line preserved
//      (`src/comp` → `src/components/`, `pac` → `package.json`).
//
// One match is substituted whole; several settle on their longest common prefix
// (`npm ru` with both `npm run test:cli` and `npm run build` extends to
// `npm run `), which is where the suggestion row — now filtered by that longer
// draft — takes over. An empty line completes nothing.
export function completeLocally(text, history, entries) {
  const base = String(text == null ? '' : text);

  if (base.trim()) {
    const commands = [];
    for (const cmd of Array.isArray(history) ? history : []) {
      const c = String(cmd == null ? '' : cmd);
      if (!c || c === base) continue;
      if (c.startsWith(base) && !commands.includes(c)) commands.push(c);
    }
    if (commands.length) {
      return commands.length === 1 ? commands[0] : longestCommonPrefix(commands);
    }
  }

  // The word being completed: everything after the last whitespace. A trailing
  // space means there is no word to act on.
  const at = base.search(/\S*$/);
  const word = at === -1 ? '' : base.slice(at);
  if (!word) return null;
  const prefix = at === -1 ? base : base.slice(0, at);
  const needle = word.toLowerCase();
  const names = [];
  for (const name of nameTokens(entries)) {
    if (!name || name === word) continue;
    if (name.toLowerCase().indexOf(needle) !== 0) continue;
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length) return null;

  return names.length === 1 ? prefix + names[0] : prefix + longestCommonPrefix(names);
}

// longestCommonPrefix(list) — the shared head of every candidate, so a Tab with
// several matches advances as far as they agree and stops, changing nothing when
// they agree on nothing more than what was already typed.
function longestCommonPrefix(list) {
  return list.reduce((acc, s) => {
    let i = 0;
    while (i < acc.length && i < s.length && acc[i] === s[i]) i++;
    return acc.slice(0, i);
  });
}

// stepHistory(history, index, dir) → { index, text }
//
// The modal's own ↑/↓, walking the same `history` list the suggestion row shows
// (newest first, index 0) instead of the shell's readline history — so a recall
// works on a session with no terminal too, and never sends a byte to the child.
// `index` is where the walk sits: `-1` is "not walking" (the field holds a fresh
// line). ↑ moves to older entries (index + 1), ↓ back toward the newest
// (index - 1).
//
// ↓ past the newest and ↑ past the oldest are clamped: ↓ returns to `-1` with an
// empty line (what a terminal does — the draft you were writing is the one thing
// readline does not keep, and holding a second copy here would mean tracking the
// field), ↑ stays on the oldest entry. With no history at all, `text` is `null`
// and the field is left untouched.
export function stepHistory(history, index, dir) {
  const list = Array.isArray(history) ? history : [];
  if (!list.length) return { index: -1, text: null };
  const at = typeof index === 'number' && index >= 0 ? index : -1;
  if (dir === 'down') {
    if (at < 0) return { index: -1, text: null };
    const next = at - 1;
    if (next < 0) return { index: -1, text: '' };
    return { index: next, text: list[next] };
  }
  const next = at < 0 ? 0 : Math.min(at + 1, list.length - 1);
  return { index: next, text: list[next] };
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
