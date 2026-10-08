# Cross-process race test

## Overview

The cross-process race test starts **two** mouaif servers over one shared app store and one shared project folder, then drives the same HTTP surface from both at once. Every case asserts that the state left behind is one a single server could have produced; a case fails only when the result is impossible without a race. A single-server test run cannot produce any of these, because the defects live in the read-modify-write windows between two processes.

## Usage

Run the whole stack — build the production image, start two servers, run the probe:

```bash
npm run test:race
```

Remove the containers and both isolated volumes afterward:

```bash
docker compose -f compose.race.yaml down --volumes
```

The suite exits non-zero when it finds a race. That is its normal, expected result for a checkout that has one to find, so treat a failing run as a report rather than as a broken test.

For iterating on a fix without rebuilding an image, the same probe runs against two locally spawned servers:

```bash
npm run test:race:local
```

Both entry points share `scripts/test-race.js`, so a fix confirmed locally still has to be confirmed on the image. Use the compose stack for that confirmation: the race has to be reproducible by what ships, not by a dev server.

## What the stack looks like

| Service | Role |
| --- | --- |
| `app-a`, `app-b` | The production image, two replicas, one `race-data` volume, one `race-workspace` volume |
| `test` | `scripts/test-race.js`, addressing both servers |

Both app replicas prepare the shared workspace before serving (`mkdir -p /workspace/project/race` plus an empty `.mouaif.json`). The workspace volume is seeded from the image's own `/workspace`, which ships owned by `node`, so no root-owned init container is needed — and that matters, because `--abort-on-container-exit` stops the whole stack the moment any container exits, and a one-shot init service would end the run before the test service started.

The probe refuses to run when the servers do not share one app store, so a misconfigured stack reports a setup error instead of silently testing nothing.

## The cases

Each case is a shape of shared state that two servers can disagree about.

- **Concurrent file write.** Sixteen writers `PUT` a full body to the same project file. The file API stages to `<path>.mouaif-tmp` and renames, and that staging name is derived from the target alone — so two processes write the same staging file and one rename finds nothing. The case asserts no writer is rejected for that reason, and that the stored file is one writer's complete body rather than a tear.
- **Concurrent project settings.** Both servers `PUT /api/settings/project` with disjoint keys. `setProject()` reads the project blob, merges, and writes it back, so keys written by one server disappear when the other's merge lands.
- **Concurrent app store.** Provider writes and project registrations from both servers, in bursts, all against the single `app_kv` row. Every one is a read-modify-write with no compare-and-swap, so entries vanish from the lists that follow.
- **Concurrent message append.** Two servers append to one chat. `appendMessage` derives the next `seq` from `MAX(seq)`, so the case checks that no two rows share a `seq`, that the number of stored rows equals the number of accepted appends, and that `seq` stays contiguous from zero — the identity the client's merge-by-seq and the window loader's `hasMore` both assume.
- **Concurrent chat update.** `chatdb.updateChat` reads the row, merges the patch, and rewrites every column, so a patch to one field can revert a concurrent patch to another. The case writes two disjoint field families and asserts all four fields survive.
- **Concurrent app setting value.** Many concurrent `PUT /api/settings/app` of one allowlisted key must leave one submitted value, not a merged blob.

## Tuning

The scale knobs are environment variables, read by `scripts/test-race.js` and set in `compose.race.yaml`:

```bash
RACE_CONCURRENCY=32        # writers per burst (default 16)
RACE_SETTINGS_ROUNDS=200   # read-modify-write rounds per server (default 60)
RACE_MESSAGE_WRITERS=12    # concurrent message appenders (default 12)
RACE_FILE_SIZE=262144      # bytes per racing file body (default 65536)
```

Raise `RACE_CONCURRENCY` and `RACE_SETTINGS_ROUNDS` to widen a race window while investigating a fix; lower them to keep a quick check quick.

## Related

- `compose.race.yaml` is separate from `compose.test.yaml` on purpose. The [Docker smoke test](./docker-smoke-test.md) answers "does the shipped image work at all"; this stack answers "does it still work when two of them share the state". A failing race probe therefore never looks like a broken release.
