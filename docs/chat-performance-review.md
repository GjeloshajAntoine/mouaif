# Chat performance review: profile against the 10-21 baseline, and a memory check

Review date: 2026-11-22, on HEAD `5ec4e5a8`. Three questions: would rewriting the chat transcript as Preact components keep it fast, how the current code compares with the committed baseline `perf/latest.json` (2026-10-21), and whether chat has a memory leak.

## Summary

- **Opening chats, page size and memory got much better** since 10-21. Hiding far-off rows (`06b07319`) and push notices replacing polling (`21235988`), both landed on 11-21, account for most of it.
- **Scrolling got slower in every chat**, very likely from that row hiding (windowing).
- `scripts/perf-compare.mjs` counts **34 metrics better, 12 worse, 27 unchanged**.
- **No growing leak** in normal signed-in use, but after you leave a chat its whole screen stays in memory (about 6 MB) because two variables still reference it.
- **A Preact rewrite of the transcript would not stay as fast by default.** Only the parts that change rarely are worth moving.

## How it was measured

- `node scripts/perf-profile.mjs` against prod `:8080`, through the `:9222` Chrome (version 140, the same as the baseline), at a 430 × 932 phone viewport.
- The only version difference from the baseline is Node (v24.15.0 → v24.22.1).
- The four seeded `[perf]` chats were removed after the run. `perf/latest.json` was not replaced.
- The raw report is kept on this machine at `perf/runs/2026-11-22T13-46-34-571Z.json` (git-ignored). To repeat the comparison:

```sh
node scripts/perf-compare.mjs perf/latest.json perf/runs/2026-11-22T13-46-34-571Z.json
```

## Better

| Metric | 10-21 | 11-22 |
|---|---|---|
| First row shown | 618 ms – 1.08 s | 510 – 774 ms (up to 53% faster) |
| Page elements after opening a chat | 1,062 – 10,654 | 888 – 1,351 (up to 90% fewer) |
| Page elements after loading a chat's whole history | 11k – 138k | 1.3k – 10k (82–95% fewer) |
| Longest task while opening | 123 – 284 ms | 130 – 187 ms (worse on 2 real chats, by 14 and 55 ms) |
| First contentful paint / page load | 484 / 364 ms | 388 / 276 ms |
| Server memory | 271 MB | 205 MB |

Element counts no longer grow with history: the 10,000-row chat stays at about 10k elements instead of 138k, and opening it costs about the same as a 30-row chat.

## Worse

### Time per scroll step

| Chat | 10-21 (median / slowest 10%) | 11-22 |
|---|---|---|
| synthetic medium (500 rows) | 27 / 40 ms | 35 / 63 ms |
| synthetic long (2,000 rows) | 16 / 98 ms | 42 / 94 ms |
| real, 2,622 rows | 14 / 19 ms | 34 / 77 ms |
| real, 2,729 rows | 16 / 38 ms | 28 / 88 ms |
| real, 2,927 rows | 17 / 24 ms | 29 / 54 ms |
| synthetic huge (10,000 rows) | 25 / 35 ms | 40 / 70 ms |

- Only 7 samples per chat, but the slowdown shows in all six.
- The Chrome was much lighter this time (2 documents and 85 elements, against 9 documents and 265k), so the environment would have flattered this run, not slowed it.
- The profiler scrolls in jumps of several thousand pixels, past the band of rows kept in the page, so each step has to put hidden rows back and lay them out. Finger scrolling moves in smaller steps, so this may overstate what a user feels, but it still points at windowing.

### Memory kept after leaving a chat

Now 5.9–11.4 MB in every chat (was 0–8 MB). The cause is in [Memory check](#memory-check).

### Time until all rows are drawn

+472 ms on synthetic long and +402 ms on the 2,729-row real chat. One sample each, so it may be noise. If real, it is probably the cost of measuring each row as it is drawn.

### Not comparable

Heap totals. The 10-21 run used a tab open for a long time (64 MB heap at load); this run used a fresh tab (16 MB). The heap drop mostly reflects that.

## Memory check

**Not a growing leak, but memory that should be released is kept.** After leaving a chat, its whole screen stays in memory (transcript included: about 13–14k elements, 2k event listeners and 6 MB). That explains the "kept after leaving" numbers above.

**How it was tested:** the 3 longest real chats were opened and left repeatedly inside one signed-in page, forcing garbage collection after each round, then heap snapshots were traced for what still references the closed chat screens. Nothing was seeded and the repo was unchanged.

| Signed-in page | Heap | Elements | Listeners |
|---|---|---|---|
| Before any chat | 6.5 MB | 1,012 | 261 |
| After 1 round (3 chats) | 12.4 MB | 14,020 | 2,219 |
| After 2 rounds | 12.7 MB | 14,020 | 2,219 |
| After 3 rounds | 12.9 MB | 13,320 | 2,119 |

Memory jumps once, then stays flat. Two holders each keep one old chat screen alive:

1. **`atMention.js` never forgets the composer.** `mountAtMention` (`frontend/src/components/chat/atMention.js:836`) stores the textarea, popup and arg bar in module variables (lines 28, 29, 67). Its cleanup clears `uiState` but not `textarea`, `popup` or `argBar`. Through the textarea's parents, the closed chat screen and its transcript stay alive until the next chat opens.
2. **The header logo is a shared element object.** `BrandMark` (`frontend/src/components/App.jsx:196`) is one element created at load and reused in every render. Preact writes a link to its parent onto that object, so the old render tree, including the previous chat screen, stays alive. The `TabIcon` entries (`App.jsx:146`) look like the same pattern.

**Fix:** clear the three variables in the at-mention cleanup, and make `BrandMark` (and the `TabIcon` entries) small components. That should bring "kept after leaving" close to zero.

**Unconfirmed lead.** In some runs the test tab started signed out and received the cookie without reloading. Memory then grew by about 111 elements, 23 listeners and 0.1–0.2 MB per chat visit, without levelling off over 8 rounds. Snapshots showed copies of the chat screen held by callbacks waiting on `sharesReady` (`frontend/src/api.js:383`), which every project API call waits on. `/api/share/state` answers in 3–5 ms, so why it was still pending is unexplained. This may only happen in a tab signed in without a reload; whether a real sign-in reloads the page was not checked.

## Would a Preact rewrite of the transcript stay fast?

The outer chat screen is Preact. The transcript is hand-written DOM code: `transcript.js` alone is about 4,400 lines, about 10.5k with `cards.js`, `toolRender.js`, `stream.js` and `useChatState.js`. It shares one mutable `state` object across about 20 modules and never re-renders. Much of it does work a framework would do (keyed row matching, a lookup table for tool cards, header card order); the rest is deliberate speed work.

| Path | Today | Plain Preact version | Effect |
|---|---|---|---|
| Streaming tokens | Appends a text node per token, O(1) | State per token makes Preact re-set the whole string, O(n²) | **Slower** unless the live row stays hand-written |
| List updates | Hand-written keyed matching | Built in through `key` | **Better**: hundreds of lines go away |
| Tool call and result | Two messages, one card, resolved by hand | Messages first grouped into one item per card | Neutral |
| Embedded app cards (MCP apps, extension renderers) | Never moved | If Preact moves a card, the iframe reloads | **Risk** |
| Hiding far-off rows | Moves a row's children out, keeps the row | Rows unmount; expanded state and lazy bodies need a store keyed by row | Workable |
| Newest-first loading | 40 rows, then older chunks with scroll correction | Doable with `useLayoutEffect` | Neutral |
| Memory | DOM only | Adds a virtual-DOM copy per mounted row | Slightly worse |

72 test scripts load these modules, many by pulling single functions into a sandbox, so most would need rewriting too.

Rules that would keep a rewrite fast:

1. Keep the streaming reply hand-written; turn it into a component only when the turn finishes.
2. Memoize each row on its message object (messages are replaced, never edited). The list re-renders only when rows are added or removed, never per token.
3. Group each tool call and its result into one item keyed `tool:<id>`.
4. Never move cards that hold an iframe; keep them out of the reordered list.
5. Keep each row's UI state (expanded, body built) in a store keyed by row, so hidden rows can unmount and come back unchanged.

**Recommendation:** no big-bang rewrite. Convert the parts that change rarely but are hard to keep in order (header cards, approval and question cards) into Preact islands, and measure before going further.

## Other findings

- **Every streamed token searches the transcript.** `appendDeltaToLive` (`frontend/src/components/chat/transcript.js:646`) runs `querySelector('[data-live="1"]')` on each token, and `appendTextToAnswer` runs another search inside the row. The same lookup appears in 13 places. Keeping a reference to the live row and its answer element is a small, safe fix.
- **A long reply leaves thousands of text nodes** while streaming (one per token), until the turn finishes and is redrawn as markdown. Expected, but worth knowing.

## Next steps

1. **Memory after leaving:** apply the two fixes above, rebuild, and re-run the open/leave cycle to confirm memory drops back to the starting level.
2. **Scrolling:** wake rows a little before they reach the screen and spread the work over several frames instead of all inside the scroll frame. Re-run with `--profiles long --real 1 --scroll-steps 30` for smoother steps and a less noisy number.
3. **Per-token lookups:** keep a reference to the live row.
4. **New baseline:** once these land, replace `perf/latest.json` with a fresh run.
