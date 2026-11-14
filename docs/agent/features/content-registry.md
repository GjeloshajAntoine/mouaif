# Content registry — implementation notes

Public page: [`docs/features/content-registry.md`](../../features/content-registry.md).

- The registry is plain data with no imports, so `src/settings.js` can require it without a cycle.
- `clientVisible`, `resettable` and `approval` describe a top-level document key. `toolOutput.size` and `toolOutput.structure` both carry them for `toolOutput`.
- Unregistered project keys still pass through: `.mouaif.json` stays open-ended.
- `DEFAULTS` is deep-frozen. `getResolved()` already clones what it merges, so nothing may mutate the floor.
- Plan and later steps (one write path, storage adapters, change cards, search): [docs/agent/plans/settings-architecture.md](../plans/settings-architecture.md).
