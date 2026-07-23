# Client domains and legacy progress tool

## Overview

This page documents client domains and the retained compatibility implementation of `report_progress`. The experimental global toast overlay was removed: it duplicated chat cards, consumed screen space, and did not provide the OS-level question and authorization interactions described in [Push notifications](push-notifications.md).

## Usage

### Legacy `report_progress` tool

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

The dispatcher can still process `report_progress` for compatibility with existing tool history, but it is no longer advertised to models and `progress_update` no longer creates a global toast or Web Push alert. Chat questions, authorization, completion, and errors are the supported notification events.

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
| `src/tools/progress.js` | `report_progress` tool spec, validator, and result builder |
| `src/clientDomains.js` | Server-side CRUD for client domains in SQLite |
| `src/web/src/components/SettingsClientDomains.jsx` | Client domains list + create UI |

### Key design decisions

- `report_progress` remains dispatchable so persisted or external tool calls fail gracefully, but it is not advertised in new model requests.
- Client domain API keys are SHA-256 hashed before storage; the plaintext is returned once on creation. The `regenerate-key` endpoint returns the new key once.
- The `client_domains` table is created via `CREATE TABLE IF NOT EXISTS` in `settings.js` alongside the other tables.