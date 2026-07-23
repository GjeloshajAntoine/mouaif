# Notifications overlay, progress tool, and client domains

## Overview

Three new features that enhance the user experience:

- **Notifications overlay** — a signal-driven toast/notification layer that stacks progress bars, success/error/info toasts, and auth/ask popups at the bottom of the viewport.
- **Percentage progress tool** (`report_progress`) — a native tool the AI model can call to show a live progress bar on the frontend during long operations.
- **Client domains** — a settings screen to manage allowed origins and API keys for external clients accessing the mouaif API.

## Usage

### Notifications overlay

The overlay is rendered automatically by `NotificationsOverlay` in the app shell. Notifications with the same caller-supplied `id` are upserted instead of duplicated, which keeps live progress events to one card per tool call. Any module can push notifications:

```js
import { addNotification, updateNotification, removeNotification } from '../notifications.js';

// Show a progress bar
const id = addNotification({ type: 'progress', title: 'Building...', progress: 0, progressMax: 100, autoClose: false });
updateNotification(id, { progress: 50, message: 'Halfway there' });
removeNotification(id);

// Show a toast
addNotification({ type: 'success', title: 'Done', message: 'Operation completed' });
addNotification({ type: 'error', title: 'Error', message: 'Something went wrong' });
addNotification({ type: 'info', title: 'Info', message: 'FYI' });
```

The `NotificationsOverlay.jsx` module also exports convenience helpers:

```js
import { showProgress, updateProgress, removeProgress, showToast } from './NotificationsOverlay.jsx';

showProgress('Building', 'Compiling...', 0, 100);
updateProgress(id, 50, 100, 'Still compiling...');
removeProgress(id);
showToast('success', 'Done', 'All good');
```

### `report_progress` tool (AI model)

The model can call `report_progress` with this schema:

```json
{
  "title": "Building project",
  "current": 5,
  "total": 100,
  "status": "running",
  "message": "Compiling source files..."
}
```

The server emits a `progress_update` SSE event. The frontend shows a progress bar notification that auto-removes after completion.

### Client domains

Settings → App defaults → Client domains. The UI lists all configured domains with their masked API key prefix. Actions:

- **Add domain** — enter an origin pattern (e.g. `https://*.example.com`) and receive a one-time API key.
- **Regenerate key** — replace an existing key; the old key stops working immediately.
- **Delete** — remove the domain and invalidate its key.

The API key is a 64-character hex string (32 random bytes). It is hashed with SHA-256 before storage; the plaintext key is shown only once at creation time.

## Implementation notes

### Files

| File | Purpose |
|------|---------|
| `src/web/src/components/notifications.js` | Signal-based notification store (add, remove, update) |
| `src/web/src/components/NotificationsOverlay.jsx` | Preact overlay rendering stacked notifications |
| `src/web/src/notifications.css` | Mobile-first styles for the overlay |
| `src/tools/progress.js` | `report_progress` tool spec, validator, and result builder |
| `src/clientDomains.js` | Server-side CRUD for client domains in SQLite |
| `src/web/src/components/SettingsClientDomains.jsx` | Client domains list + create UI |
| `src/web/src/components/PwaInstallBanner.jsx` | PWA install banner using `beforeinstallprompt` |

### Key design decisions

- Notifications are signal-driven and rendered by a single Preact component in the app shell, not by individual views.
- Caller-supplied notification IDs are upserts; this avoids duplicate progress toasts when SSE progress frames arrive before the DOM has repainted.
- Progress bars render determinate percentages when `total > 0` and an indeterminate animated track when the total is unknown.
- The `report_progress` tool is always advertised to the model (no authorization gate — it is read-only metadata).
- Client domain API keys are SHA-256 hashed before storage; the plaintext is returned once on creation. The `regenerate-key` endpoint returns the new key once.
- The `client_domains` table is created via `CREATE TABLE IF NOT EXISTS` in `settings.js` alongside the other tables.