# Project card search — implementation notes

> Agent-facing reference for [`docs/features/project-card-search.md`](../../features/project-card-search.md). The human-facing surface lives in that file; the query shape, the client state machine, and the source paths live here.

## Why a new endpoint instead of filtering the loaded page

The card only holds one page of chats (`CHAT_PAGE_SIZE = 30`, then scroll-to-load). Filtering that array in the browser would search the thirty rows the user happens to have scrolled into, and would miss the match in the message body entirely, since list rows never carry message text. So search is a server query over `chat_store` and `message_store`, and the card renders its answer instead of its page.

## `GET /api/chats/search`

| Query | Required | Meaning |
|-------|----------|---------|
| `projectDir` | yes | Absolute project directory (400 when missing). |
| `q` | no | The term. Blank/whitespace is an empty result, not an error. |
| `limit` | no | Max chats to return, default 20, capped at 100 in `src/chatdb.js`. |

Response: `{ chats: [...], query, total }`. Each `chats` entry is the same summary `GET /api/chats` returns (see `LIST_COLUMNS` in [src/chatdb.js](../../../src/chatdb.js)), plus:

- `matchField` — `title` | `draft` | `message`, why the row is in the list;
- `snippet` — a bounded one-line window of the matching text (head of the matched body, elided with `…` on either side when the hit is deep in a long message, hard-capped at 240 chars).

The handler in [src/server-handlers-chats.js](../../../src/server-handlers-chats.js) adds the same enrichment the list branch adds: a bulk `messageCount` (`messages.projectMessageCounts`, one indexed `GROUP BY`) and the response-only `running` flag. A search row renders through the card's normal row code path, so those fields must be present.

## The query

Two `LIKE` predicates over two tables, folded to one row per chat:

```sql
SELECT chat_id, MAX(title_hit) AS title_hit, MAX(draft_hit) AS draft_hit,
       MIN(match_seq) AS match_seq FROM (
  SELECT id AS chat_id, 1 AS title_hit, 0 AS draft_hit, NULL AS match_seq FROM chat_store
    WHERE project_dir = @dir AND title LIKE @like ESCAPE '\'
  UNION ALL
  SELECT id AS chat_id, 0 AS title_hit, 1 AS draft_hit, NULL AS match_seq FROM chat_store
    WHERE project_dir = @dir AND draft LIKE @like ESCAPE '\'
  UNION ALL
  SELECT chat_id, 0 AS title_hit, 0 AS draft_hit, MIN(seq) AS match_seq FROM message_store
    WHERE project_dir = @dir AND content LIKE @like ESCAPE '\'
    GROUP BY chat_id
) GROUP BY chat_id
```

Then joined back to `chat_store` for the summary columns, ordered `COALESCE(last_opened_at, created_at) DESC, id DESC` — the exact ordering `listChats` uses — and capped by `LIMIT`.

- **The fold is what keeps it bounded.** A chat with 40 matching messages contributes one row, so `LIMIT 20` means twenty chats, not twenty messages. `MIN(seq)` is the earliest matching message, i.e. the first place in the transcript the term appears.
- **`MIN(content)` is deliberately not in the projection.** The obvious way to get a snippet in one statement is to carry `MIN(content)` (or a `substr` expression) through the aggregate — which makes SQLite read *every* matching message body to keep one. Searching `a` in a real store matches nearly every row. Instead the fold returns `match_seq` and the snippet is one primary-key lookup per result row (`SELECT content FROM message_store WHERE project_dir = ? AND chat_id = ? AND seq = ?`), riding `idx_message_store_lookup (project_dir, chat_id, seq)`.
- **The draft snippet reads a head.** A draft-only match does `SELECT substr(draft, 1, N)`. The column can hold a pending image draft of megabytes; `LIST_COLUMNS` already avoids it for the same reason.
- **Third draft sub-select rather than `title LIKE … OR draft LIKE …` in one** — because `title_hit` and `draft_hit` must stay distinguishable for `matchField`.
- **LIKE, not FTS5.** A user query is a substring, not a token list, and `fts5` is not guaranteed to be compiled into every better-sqlite3 prebuild. LIKE's default case-insensitivity for ASCII is what the user expects from a search box.
- **`%` and `_` are escaped** (`escapeLike`, `ESCAPE '\'`), so typing `100%` finds "100%" instead of matching everything. Backslashes are doubled first: escaping `%`/`_` before `\` would re-escape the escape characters this adds.
- **Iteration cost.** No new index. The predicates are `LIKE '%term%'`, which cannot use an index, so the query is O(rows in the project) — the same order as `countChats` and `projectMessageCounts` already cost on every Chats-tab load, and the response is bounded by `LIMIT`. An FTS5 table with triggers on `message_store` is the upgrade path if a project ever grows large enough to feel it.

## Client: [frontend/src/components/Projects.jsx](../../../frontend/src/components/Projects.jsx)

State lives in `ChatList` (one instance per project card, so two cards can be open at once): `searchOpen`, `term`, `results`, `searching`, a `searchInputRef`, and a `searchSeq` counter.

The important rule is what decides between "show results" and "show the normal list":

```js
const answered = results && results.query === term.trim() ? results : null;
const searchMode = searchOpen && term.trim().length > 0;
```

`results.query` is the term the server answered. While the user keeps typing, `results.query !== term`, so `answered` is `null` and the card shows *neither* stale results nor the pre-search page: it shows the searching line. This is what makes a stale answer structurally impossible to attribute to a new term, rather than a race that happens to be won.

- **Debounce** — `CHAT_SEARCH_DEBOUNCE_MS = 220` via `setTimeout` returned as the effect's cleanup, so a keystroke burst collapses into one request and an unmounting card cancels its pending one.
- **Sequence guard** — each request takes `mine = ++searchSeq.current`, and only `mine === searchSeq.current` may write state. Two terms in flight with the older answering last must not overwrite the newer. `closeSearch` also increments the counter, so an answer for a closed field lands nowhere.
- **Focus** — the input is mounted by the same render that flips `searchOpen`, so `openSearch` focuses inside `requestAnimationFrame` (the DOM node does not exist when the handler runs).
- **One row renderer** — `chatRow(c, match)` serves both the page and the results, because a search hit *is* a chat: same tap-to-open, same `×`, same running dot, same draft marker. Only the snippet line and the badge are conditional. The snippet is suppressed when it equals the title, which is what stops a title hit printing the same words twice.
- **Delete inside a result** goes through `dropChat(chatId)`, which removes the row from the paged list and the counts as well as from the results — otherwise closing search would resurrect a deleted chat.
- The magnifier is a real toggle (`aria-expanded`), `Escape` closes the field, and the field carries `type="search"` / `enterkeyhint="search"` so a phone keyboard offers the right key.

## Styles: [frontend/src/projects.css](../../../frontend/src/projects.css)

`.project-card__search-open` — the magnifier, `flex: 0 0 var(--tap)` with the same `border-left` separator as the custom-prompt buttons, so the action row stays one strip and every target is ≥ 44 px. `.project-card__search` is a plain row between the card head and the chat list (not sticky, no overlay): the list stays the scroll owner. `.project-card__chat-snippet` is clamped to two lines, and `.project-card__chat--match` top-aligns the row so the metadata stays beside the title instead of drifting down.

## Tests

- [scripts/test-chat-search.js](../../../scripts/test-chat-search.js) — `searchChats` and the HTTP route: the fold (26 matching messages in one chat ⇒ one row), the match label, the snippet windowing, the recency cap, blank query, case-insensitivity, literal `%`/`_`, and the same response enrichment `GET /api/chats` applies.
- [scripts/test-project-card-search-ui.mjs](../../../scripts/test-project-card-search-ui.mjs) — the real `ProjectsView` under a minimal hook harness (per-component state slots, dependency-aware effects, cleanups): the field only exists after the magnifier is tapped and is focused; one request per settled term; the searching state hides the previous term's hits; a slow older answer never lands; a failure is reported as a failure and a miss as a miss; closing clears everything.

## Docs

Public page: [docs/features/project-card-search.md](../../features/project-card-search.md), listed under **Projects and settings** in [docs/README.md](../../README.md) and in the published documentation index.
