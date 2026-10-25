# Performance and memory profile — implementation notes

> Agent-facing reference for [`docs/features/performance-memory-profile.md`](../../features/performance-memory-profile.md). The command surface lives in that file; the harness internals, the measurement traps, and the recorded baseline live here.

## Files

| Path | Role |
| --- | --- |
| `scripts/perf-profile.mjs` | The profiler: CDP session, measured steps, report writer, summary printer. |
| `scripts/lib/perf-cdp.mjs` | Minimal CDP client (Performance, Tracing, HeapProfiler, Network) plus page discovery. |
| `scripts/lib/perf-session.mjs` | Mints and revokes one temporary `access_sessions` row so the tab is signed in. |
| `scripts/lib/perf-fixtures.mjs` | Deterministic transcript generator, seeding, cleanup, real-chat ranking. |
| `scripts/perf-compare.mjs` | CLI that picks two reports (`perf/runs/`, paths, or `@<git ref>`) and prints the comparison. |
| `scripts/lib/perf-compare.mjs` | Pure comparison: metric table, noise band, label pairing, environment differences. |
| `scripts/test-perf-profile.js` | Regression test for fixtures, cleanup, the report builders, the snapshot scanner and the comparison. |
| `perf/latest.json` | The report. Committed. |
| `perf/latest.manifest.json`, `perf/snapshots/` | Run state and raw V8 snapshots. Git-ignored. |
| `perf/runs/<stamp>.json` | Copy of each default-path run, so `latest.json` being overwritten loses nothing. Git-ignored. |

## Baseline (recorded 2026-10-21)

Environment: 2 vCPU, 3.8 GB RAM, Chrome 140 headless, 430×932 @2x, app store 1.58 GB, project `/home/ubuntu/mouaif`.

| Transcript | Rows | First row | Complete | Transcript nodes | Rows in DOM after open |
| --- | --- | --- | --- | --- | --- |
| synthetic tiny | 30 | 1.08 s | 1.24 s | 612 | 23 |
| synthetic medium | 500 | 906 ms | 1.08 s | 6,671 | 241 |
| synthetic long | 2,000 | 935 ms | 1.11 s | 10,204 | 316 |
| real | 2,622 | 763 ms | 969 ms | 1,696 | 1 |
| real | 2,729 | 618 ms | 849 ms | 1,698 | 2 |
| real | 2,927 | 870 ms | 1.05 s | 1,698 | 2 |
| synthetic huge | 10,000 | 973 ms | 1.14 s | 6,106 | 261 |

Shell: FCP 484 ms, load 364 ms, TTFB 51 ms, 590 DOM nodes, 67.99 MB JS heap. Chat list: 3 project cards, 79 chat rows. Endpoints on the longest real chat: list page 17 ms / 10.6 KB, newest page of 100 rows 10.5 ms / 58 KB, full transcript 139 ms / 2.0 MB (1,466 rows), revision 10 ms.

Draining pagination (the whole-history case):

| Transcript | Pages | Rows on screen | Transcript nodes | Median page |
| --- | --- | --- | --- | --- |
| synthetic medium | 2 | 452 | 11,439 | 6.28 s (first page) / ~0.9 s |
| synthetic long | 8 | 1,750 | 49,515 | 898 ms |
| synthetic huge | 34 | 6,603 | 138,137 | 1.69 s |
| real (2,622 rows) | 13 | 1,312 | 14,101 | 662 ms |

## Findings

- **Open time does not grow with stored length.** First row stays between 618 ms and 1.08 s regardless of whether the chat holds 30 or 10,000 rows (0.9× across a 333× increase). This is the backward-pagination design working: a chat opens with its newest 100 rows (docs/features/chat-backward-pagination.md).
- **Open cost is the app shell plus one page.** Every number above is a full document load, so what dominates a fresh open is the shell (FCP ~480 ms) and the newest-page fetch (~10 ms), not the transcript.
- **Reading a long chat is where the DOM grows.** Draining history takes the 10,000-row chat to 6,603 rows and 138,137 nodes, and the per-page cost climbs from roughly 0.7 s to 3.3 s as the node count climbs — the page-prepend cost tracks the existing DOM size, not the page being added.
- **The transcript is not windowed.** After the drain, every row that was ever loaded stays in the DOM (`renderedRows` tracks `sourceRows`). `frontend/src/virtual-list.js` is used by the Inspector and Settings tags, not by the chat transcript, so the "windowed rendering, recycled nodes" claim in the project notes does not currently describe the transcript.
- **Starting over in the same tab does not return the heap.** Leaving each measured chat left 0 to 8 MB above the pre-open baseline; the tab ended the run at ~75 MB after seven transcripts. It is bounded and does not grow per chat without limit, but it is not zero either — worth a repeat measurement before being called a leak.
- **Inline SVG icons are a visible per-card cost.** In the drained 10,000-row snapshot, `SVGAnimatedLength` appears 55,720 times for 3.5 MB. Each tool card's chevron is an inline `<svg>` assigned with `chev.innerHTML` (`frontend/src/components/chat/transcript.js` lines 1018 and 2311); a shared `<use>` symbol or a CSS-only triangle would take that off every card.

## Measurement traps (why the harness looks the way it does)

These each produced a wrong number before being fixed. Keep them in mind before changing the harness.

1. **A hash change is not a document load.** `Page.navigate` to a URL differing only in `#/…` keeps the same document: the app's router reacts, but `performance.now()` still counts from the *previous* navigation and app state (including a signed-out shell) survives. Every measured step therefore loads `?perf=…` and then reloads once with the route set, so the numbers mean "time since the user opened this".
2. **The app tab is often signed out.** An expired session still renders a complete, believable DOM — the sign-in screen. The profiler mints one temporary session, proves `authenticated === true` before measuring, and revokes it at the end. `document.cookie` on the page's own origin is used rather than `Network.setCookie`, which did not apply to the document that was about to be created.
3. **A background tab never fires `requestAnimationFrame`.** Chrome suspends rAF and throttles timers there. Every in-page wait carries a `setTimeout` fallback, and the report records `visibility` so a timer-bounded run is labelled instead of silently compared with a foreground one.
4. **`Performance.getMetrics` mixes two clocks.** `DomContentLoaded` / `loadEventEnd` are milliseconds since navigation start while the paint metrics are absolute monotonic clocks. Paints now come from PaintTiming/LCP entries and load from `PerformanceNavigationTiming`; mixing them is how an earlier report claimed `loadEventEnd: 1145459`.
5. **A heap snapshot is 40-200 MB of JSON.** `JSON.parse` needs several times that in RAM on a 4 GB box that also runs the app, Chrome and the server; it OOM-killed whole runs. `summarizeHeapSnapshot` scans the file for the four flat arrays it needs (`strings`, `node_fields`, `node_types`, `nodes`), agreed byte-for-byte with `JSON.parse` on a fixture (see the regression test).
6. **`reportHeapSnapshotProgress` is not a completion signal.** Waiting for its `finished` event deadlocked; the chunks are all delivered before `takeHeapSnapshot` resolves, so they are collected by the listener and written afterwards.
7. **Fixtures must match the real row shape.** This project's store keeps tool payloads in `content` as JSON (`{ name, args }` for a call); the first fixture put them in an `args` column. That made synthetic transcripts draw far more cards per row than real ones, which flattered both node counts and heap. `scripts/test-perf-profile.js` now asserts the payload shape.
8. **"Rows in the DOM" and "rows in the store" differ by design.** A real 2,927-row chat showed one or two transcript rows because 2,924 of its rows are tool calls/results that collapse into a handful of cards. Compare `transcriptNodes` when comparing across transcripts, not `rows`.

## Comparison rules

`compareReports(base, head)` reads the full report, not only `summary`, so the whole-history numbers (`fullHistory.heapGrowth`, `pageMs.median`, `nodesAfter`) and `heap.retainedAfterLeave` take part. The decisions that are easy to undo by accident:

- A metric absent on either side is `missing`, never a regression (an older report, or a drain pass that was skipped).
- The noise band is a percentage with an absolute floor per unit (25 ms, 1 MB, 5 nodes), so 10 ms → 30 ms does not read as +200%. Node counts come from fixed fixtures and use at most a 2% band.
- Pairing is by exact `label`. Do not fall back to pairing real chats by rank: the longest chat changes as the user works, and comparing two different chats attributes the difference to the code.
- Server RSS is a single end-of-run sample that includes the cost of seeding the 10,000-row fixture. It is good for comparing runs of the same profile set, not for finding a leak.

## Limits

- The frame timings are only meaningful in a foreground tab. Run the profile with the app tab focused; the report states `visibility`.
- `perf/latest.json` is a snapshot of one machine at one moment. Compare two runs from the same box, same viewport and same Chrome version, not across machines.
- The drain pass is budgeted (`--drain-deadline`, default 90 s). When it is hit, `deadlineHit` is true and the row/node totals are a floor rather than the whole history.
- Retained size per object is not computed (that needs the DevTools dominator pass); the snapshot summary reports self size and instance counts, which is enough to spot a class growing with the row count.
