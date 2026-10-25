# Performance and memory profile

## Overview

A repeatable recording of how the app performs and what it holds in memory: the app shell, the chat list, and long chats from 30 rows up to 10,000. It runs against the copy of mouaif you already have open in Chrome, writes a JSON report, and removes the chats it created.

## Usage

Record a profile while the app is running and Chrome is on its debug port:

```bash
node scripts/perf-profile.mjs
```

The report lands in `perf/latest.json`. The run prints a one-screen summary, so the numbers are readable without opening the file:

```text
 shell      22.04 s   FCP 484 ms   heap 67.99 MB   nodes 590
 transcript       rows  first row   complete     nodes       heap
 synthetic      30 rows  1.08 s   1.24 s         1062   70.53 MB
 synthetic     500 rows  906 ms   1.08 s         7121   65.43 MB
 synthetic   2,000 rows  935 ms   1.11 s        10654   64.32 MB
 real        2,622 rows  763 ms   969 ms         2151   59.76 MB
 real        2,729 rows  618 ms   849 ms         2153   65.03 MB
 real        2,927 rows  870 ms   1.05 s         2153   75.66 MB
 synthetic  10,000 rows  973 ms   1.14 s         6556   75.05 MB
 server RSS 271.46 MB (pid 2404956)
```

The shell line takes ~22 s because it measures a cold document load of the whole app; the per-transcript times are each a fresh document too, so they are directly comparable.

Common options:

| Option | What it does |
| --- | --- |
| `--base <url>` | App URL to profile (default `http://127.0.0.1:8080`). |
| `--port <n>` | Chrome debug port (default `9222`). |
| `--project <dir>` | Project whose chats are profiled (default: this repository). |
| `--profiles tiny,medium,long,huge` | Synthetic transcript sizes to seed and measure. |
| `--real <n>` | Also profile the project's `n` longest real chats (default 3, `0` disables). |
| `--quick` | Medium and long fixtures, one real chat, one heap snapshot. |
| `--no-full-history` | Skip draining pagination to measure the whole transcript. |
| `--snapshots <n>` | How many V8 heap snapshots to keep (default 3, `0` disables). |
| `--keep` | Keep the seeded chats afterwards. |

Two follow-up commands cover the cases a normal run does not:

```bash
# Delete the chats a previous run listed, then exit.
node scripts/perf-profile.mjs --cleanup-only perf/latest.manifest.json

# Check the fixtures, cleanup and report builders without Chrome or a server.
node scripts/test-perf-profile.js
```

## Comparing runs

Every run with the default report path is also kept as `perf/runs/<stamp>.json` (git-ignored, one file per run on this machine). `perf/latest.json` is the committed baseline.

```bash
node scripts/perf-compare.mjs                    # the two newest runs
node scripts/perf-compare.mjs old.json           # old.json against perf/latest.json
node scripts/perf-compare.mjs @HEAD~3 @HEAD      # two committed baselines
```

```text
Server
  server RSS   271.46 MB → 380.05 MB   +108.58 MB (+40%) ▲ worse

synthetic long (2000 rows)
  first row      935 ms → 1.87 s      +935 ms (+100%)   ▲ worse
  JS heap      64.32 MB → 92.93 MB    +28.61 MB (+44%)  ▲ worse
```

Only changes are listed (`--all` adds the rest). Every metric is lower-is-better, so a rise is "worse".

- **Noise band.** A change within ±15% (`--tolerance <pct>`) counts as unchanged, and so does anything under 25 ms, 1 MB or 5 nodes. One run per configuration is noisy: the 30-row chat opened slower than the 500-row one in the recorded baseline.
- **Pairing.** Chats are paired by label. The synthetic ones are always the same; a real chat's label carries its title, so a chat that was renamed or dropped out of the top three is listed as not compared rather than matched with a different one.
- **Like for like.** If the Chrome version, viewport, CPU count, tab visibility or host differ, the output says so first. Compare runs from the same box.
- **Exit code.** `--fail-on-regression` exits 1 when anything got worse; `--json` prints the comparison for scripts.

## What is measured

Each synthetic transcript is a real chat in the store, with markdown, code blocks, tables, reasoning blocks and tool call/result pairs at a fixed seed, so two runs are comparable.

| Step | Numbers |
| --- | --- |
| App shell | First Contentful Paint, document load, transfer size, DOM nodes and JS heap after load. |
| Opening a chat | Time to first row, time until the transcript stops growing, DOM nodes, heap, and long tasks over 50 ms. |
| Scrolling a page | Time per scroll step and the heap after the pass. |
| Draining history | Pages fetched, time per page, rows and DOM nodes on screen, heap growth, and bytes per row. |
| Leaving a chat | Whether the heap returns to where it was before the chat was opened. |
| Heap snapshot | Retained objects by constructor, taken at the drained state. |
| Chat list and Inspector | The same load numbers, plus the latency of the chat-list, newest-page, full-transcript and revision endpoints. |
| Server | Resident memory and thread count of the process serving the app, read once at the end of the run. |

Long chats open with only their newest page, so open time stays flat as stored length grows; the drain pass is what shows the cost of holding a whole history.

## Behavior

- Every chat loads as a real document, because the open timings have to mean "time since the user opened this chat". A hash-only route change would reuse the previous document.
- The profiler signs in with a temporary session for the configured account and revokes it when the run ends. It never asks for a password and never changes your own session.
- Seeded chats are titled `[perf] …`, recorded in `perf/latest.manifest.json`, and deleted at the end. An interrupted run is cleaned up by the next one.
- Nothing is restarted: the profile attaches to the tab you already have open. If Chrome reports the tab as hidden, frame timings are timer-bounded and the report says so.
- `perf/snapshots/` holds raw `.heapsnapshot` files, which run to hundreds of megabytes and are not committed.

## Related

- [Chat load performance](./chat-load-performance.md) — how long chats open quickly.
- [Chat streaming performance](./chat-streaming-performance.md) — the per-token streaming hot path.
- [Memory footprint and payload size](./memory-footprint.md) — lazy server dependencies and bounded caches.
- [Virtual list](./virtual-list.md) — the windowed renderer behind the Inspector lists.
