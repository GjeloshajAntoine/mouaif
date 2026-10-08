# Cross-process race test — implementation notes

## Why two servers

Every defect this suite finds lives in a window between two OS processes. `src/settings.js` keeps the app-level store in one `app_kv` row and reads it on every call, so a write is

1. `SELECT value FROM app_kv WHERE key = 'app'`
2. merge the patch in JavaScript
3. `INSERT ... ON CONFLICT DO UPDATE`

with no transaction and no compare-and-swap. Two processes interleave those steps and the later `UPDATE` writes a blob built from the earlier read: every key the other process added in between is gone. The same shape repeats per project (`setProject` → `writeProjectJson`), and `chatdb.updateChat` rewrites every column of a chat row from a value it read before the patch was applied, so a concurrent patch to a *different* field is silently reverted.

A single-process test cannot see any of it: one Node process serializes its own synchronous DB calls, and `better-sqlite3` is synchronous, so an in-process read-modify-write cannot be interleaved by another request. The race needs a second process, which is what `compose.race.yaml` provides.

## Files

| File | Role |
| --- | --- |
| `scripts/test-race.js` | The probe: every case, and the pass/fail contract. No mouaif dependency — it speaks HTTP and reads the file it wrote, so it runs unchanged in the test container and against local servers. |
| `scripts/test-race-local.js` | Docker-free runner: two free ports, two `mouaif serve` children over one `MOUAIF_HOME`, wait on `/api/settings`, run the probe, kill the pair. |
| `scripts/lib/race-target.js` | Builds the racing file bodies and judges the stored file. |
| `scripts/lib/race-client-ids.js` | Duplicates `newClientId()` from `src/messages.js`; the test container has no mouaif install. |
| `compose.race.yaml` | The stack. |

## The pass/fail contract

The probe accepts any winner. The file API documents last-writer-wins, so the outcome of a race is a choice between whole bodies and never a tear; a `4xx` under contention is also a legitimate answer. What the probe refuses is a result that is impossible without a race:

- a `2xx` whose own response contradicts what was stored;
- a write that vanished with no error;
- two message rows sharing a `seq`, or a row count that disagrees with the number of accepted appends;
- a sibling field reverted by a concurrent patch.

That asymmetry is why the suite can be left failing in a checkout: a failure names a real interleaving, not a flaky assertion.

## Detecting a specific writer in a torn file

`bodyFor(writer, size)` pads the body with a byte derived from the writer index, so the stored file identifies its author and `judgeBody` can report the byte offset where a tear begins. Accepting *any* winner is deliberate: asserting a particular winner would make the test assert an interleaving order, which is exactly the thing that is undefined.

## Docker specifics

- `race-workspace` is seeded from the image's `/workspace`, which ships owned by `node`, so the app replicas can create the fixture project themselves. No root-owned init container.
- That matters because `--abort-on-container-exit` (implied by `--exit-code-from`) stops the whole stack as soon as any container exits. A one-shot `init` service that exits 0 tears the stack down before the test service has even started, which is why the workspace prep is folded into each app's `command` instead. Both replicas write the same four bytes, so the overlap is not itself a race; the file case is the one that exercises concurrent writes.
- `docker compose -f compose.race.yaml up --build` must be run with `--abort-on-container-exit --exit-code-from test`, which `npm run test:race` does.
- The probe asserts both servers report the same `MOUAIF_HOME` and can read the shared project dir. Without that check a misconfigured stack would report green while testing nothing.

## Adding a case

A case is `[name, async () => detailString]`, collected in `CASES`. It should:

- address at least two servers, spread over `BASE_URLS`;
- assert only properties a single-server run would also have to satisfy;
- return a one-line `detail` naming the numbers that matter, because that string is the only output a CI log keeps.

Both failure modes are worth covering: a lost update (state that should be there is gone) and a torn update (state that should be one value is a mix).