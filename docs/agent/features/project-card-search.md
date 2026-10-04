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

Three statements, in increasing cost order:

```sql
-- 1. the candidate page: one row per matching chat, in recency order
SELECT <LIST_COLUMNS>,
       (c.title LIKE @like ESCAPE '\') AS title_hit,
       (c.draft LIKE @like ESCAPE '\') AS draft_hit
FROM chat_store c
WHERE c.project_dir = @dir
  AND (c.title LIKE @like ESCAPE '\'
       OR c.draft LIKE @like ESCAPE '\'
       OR EXISTS (SELECT 1 FROM message_store msg
                   WHERE msg.project_dir = c.project_dir AND msg.chat_id = c.id
                     AND msg.content LIKE @like ESCAPE '\'))
ORDER BY COALESCE(c.last_opened_at, c.created_at) DESC, c.id DESC
LIMIT @limit
```

```sql
-- 2. the first matching message: only for a candidate whose label is not yet
--    decided (a title or draft hit never runs this)
SELECT MIN(seq) AS match_seq FROM message_store
WHERE project_dir = @dir AND chat_id = @chat AND content LIKE @like ESCAPE '\'
```

```sql
-- 3. the matching body, by primary key, for a row that needs a snippet
SELECT content FROM message_store WHERE project_dir = ? AND chat_id = ? AND seq = ?
```

`EXISTS` is a semi-join, so it cannot multiply a chat row: "one row per chat"
is structural here rather than a `GROUP BY` fold. Statements 2 and 3 ride
`idx_message_store_lookup (project_dir, chat_id, seq)`.

### Why this shape, and not the fold-first one

The previous shape computed `MIN(seq) GROUP BY chat_id` over *all* matching
messages in a subquery and joined it before ranking:

```sql
-- retired: 14x slower on a 32 MB store, ~3 s on the author's 850 MB one
SELECT chat_id, MAX(title_hit), MAX(draft_hit), MIN(match_seq) FROM (
  SELECT id, 1, 0, NULL FROM chat_store WHERE title LIKE @like
  UNION ALL SELECT id, 0, 1, NULL FROM chat_store WHERE draft LIKE @like
  UNION ALL SELECT chat_id, 0, 0, MIN(seq) FROM message_store
    WHERE content LIKE @like GROUP BY chat_id
) GROUP BY chat_id
```

The `GROUP BY` has to complete before the `ORDER BY` and `LIMIT` can apply, so
a term like `e` read the entire transcript to return the newest twenty chats.
Ranking in the driving query lets the `LIMIT` stop the walk instead, which is
what `idx_chat_store_recent` serves; the plan shows the recency index leading
and no temp B-tree.

- **`match_seq` is lazy.** The label order is title → draft → message, and the
  first two need no message read at all: a title snippet is the title, a draft
  snippet is the draft head. Only a row that will be labelled `message` runs
  statement 2, so most terms never scan messages at all.
- **`MIN(content)` is deliberately not in the projection.** The obvious way to get a snippet in one statement is to carry `MIN(content)` (or a `substr` expression) through a message aggregate — which makes SQLite read *every* matching message body to keep one. Instead the seq is looked up and the body is read once per result row by primary key.
- **The draft snippet reads a head.** A draft-only match does `SELECT substr(draft, 1, N)`. The column can hold a pending image draft of megabytes; `LIST_COLUMNS` already avoids it for the same reason.
- **LIKE, not FTS5.** A user query is a substring, not a token list. LIKE's default case-insensitivity for ASCII is what the user expects from a search box. FTS5 *is* compiled into the better-sqlite3 prebuilds (`SQLITE_ENABLE_FTS5` in `deps/defines.gypi`), and a trigram mirror of `message_store` is the obvious index for this predicate — but a measured build of one over 154 MB of the author's text produced a 516 MB index (3.35× the text) in 58 s, on a store whose whole value is that the user can commit the project and keep their history. A 2.9 GB index and a minute of indexing is a worse trade than the query shape above, so the shape is the optimization.
- **`%` and `_` are escaped** (`escapeLike`, `ESCAPE '\'`), so typing `100%` finds "100%" instead of matching everything. Backslashes are doubled first: escaping `%`/`_` before `\` would re-escape the escape characters this adds.
- **Bounds.** `limit` defaults to 20 and is capped at `SEARCH_MAX_LIMIT` (100) in `src/chatdb.js`. The candidate page is bounded, and each result row costs at most one seq lookup and one body read, so the work after the page is proportional to the answer.
- **The remaining cost is honest.** A term that is genuinely rare has to read the whole transcript before it can answer, because no index can serve a substring. That is unchanged and unavoidable without an index; what changed is that the common, saturated case — which is what a user feels while typing — answers from the recent tail.

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

`.project-card__search-open` — the magnifier, `flex: 0 0 var(--tap)` with the same `border-left` separator as the custom-prompt buttons, so the action row stays one strip and every target is ≥ 44 px. `.project-card__search` is a plain row between the card head and the chat list (not sticky, no overlay): the list stays the scroll owner. `.project-card__search-count` sits between the input and the close button — an inline grid of number + unit, `hidden` when the answer is empty or failed, with the unit dropped below 360 px so the input and the × keep their width. `.project-card__chat-snippet` is clamped to two lines, and `.project-card__chat--match` top-aligns the row so the metadata stays beside the title instead of drifting down.

## Tests

- [scripts/test-chat-search.js](../../../scripts/test-chat-search.js) — `searchChats` and the HTTP route: one row per chat however many messages match, the match label, the snippet windowing, the recency cap, blank query, case-insensitivity, literal `%`/`_`, and the same response enrichment `GET /api/chats` applies.
- [scripts/test-chat-search-performance.js](../../../scripts/test-chat-search-performance.js) — the cost shape: runs the retired fold-first query beside `searchChats` on one synthetic store whose bulk sits behind the recency window, asserts the saturated search is at least 10× cheaper, and pins the `EXPLAIN QUERY PLAN` (recency index leads, no temp B-tree). The developer's real 850 MB transcript is deliberately not read.
- [scripts/test-project-card-search-ui.mjs](../../../scripts/test-project-card-search-ui.mjs) — the real `ProjectsView` under a minimal hook harness (per-component state slots, dependency-aware effects, cleanups): the field only exists after the magnifier is tapped and is focused; one request per settled term; the searching state hides the previous term's hits; a slow older answer never lands; a failure is reported as a failure and a miss as a miss; closing clears everything.

## Docs

Public page: [docs/features/project-card-search.md](../../features/project-card-search.md), listed under **Projects and settings** in [docs/README.md](../../README.md) and in the published documentation index.
