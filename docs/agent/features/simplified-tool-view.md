# Simplified tool view — implementation notes

> Agent-facing reference for [`docs/features/simplified-tool-view.md`](../../features/simplified-tool-view.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Files

| File | Role |
|------|------|
| `frontend/src/toolView.js` | `normalizeToolView`, `isToolViewActive`, `toolViewStats`, `toolViewSummary`, `TOOL_VIEW_PRESETS`, and `applyToolView`, which regroups already-built tree groups so each leaf keeps its id, checked state and control |
| `frontend/src/components/settings/ToolViewEditor.jsx` | The editor on `settings/project/tool-view` with mode cards, coverage summary bar, starter presets, searchable `ToolTree` picker, and live chat preview |
| `frontend/src/components/SettingsProject.jsx` | Holds the `toolView` state and saves the whole value through `PUT /api/settings/project` |
| `src/server-handlers-tools.js` | `GET /api/tools/list?projectDir=…` returns the resolved value as `toolView` next to `tools`, so the chat needs no extra request |
| `frontend/src/components/chat/useChatState.js` | Stores it as `state.tools.view` wherever the catalog is loaded |
| `frontend/src/components/chat/cards.js`, `ToolPopup.jsx` | Render the segmented `Simplified (N) | All (M)` switcher and active-tools scope note, and apply the view after the authorization controls are attached |

### Notes

- `toolView` is an undeclared project key: the content service stores it as-is, and readers normalize it.
- Category rows get ids `view-<index>` and no authorization control. Leaf ids stay the model-facing function names, so `groupToolNames` and the existing toggle handlers work unchanged.
- The view never changes the chat's tool filter or any authorization entry.

### Testing

```bash
node scripts/test-tool-view.mjs
```
