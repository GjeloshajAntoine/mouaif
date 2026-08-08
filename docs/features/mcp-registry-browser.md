# MCP Registry Browser

Browse the official [MCP Registry](https://registry.modelcontextprotocol.io) from within mouaif and add servers with one tap.

## Overview

The **MCP Registry Browser** integrates the official community-owned registry at `registry.modelcontextprotocol.io` into the Settings UI. Users can search, sort, explore popularity-scored server entries, and add any server as a project-scoped or app-wide MCP server without leaving the app. Browsing is stateless: mouaif requests the Registry API directly through its backend proxy and does not store or cache registry responses.

## Usage

1. Go to **Settings → MCP servers** (app or project scoped).
2. Tap the **Browse Registry** button in the bottom bar.
3. Browse the paginated list, or type a search term and hit Enter.
4. Each server card shows:
   - **Name** (short display name) + version badge
   - **Status** badge (active / deprecated)
   - **Description** (first 200 characters)
   - **Qualified name** (e.g. `io.github.user/weather`)
   - **Package count**
   - **Last updated** date
   - **Popularity score** (0–100) — a visual bar computed from update recency, package count, and version metadata
5. Tap **Add to project** (or **Add to app**) to install the server instantly. The form auto-fills:
   - Command (`uvx`, `npx`, or the package's declared command)
   - Arguments from the first package
   - Environment variables (defaults, if any)
6. After adding, the view navigates to the new server's edit screen. The new server is always on — there is no `enabled` flag to set.

## Popularity Scoring

Since the official registry does not expose download counts or star ratings, mouaif computes a composite score (0–100):

| Component | Max | Source |
|---|---|---|
| Update recency | 50 | Days since `updatedAt` (≤ 90 days = max) |
| Package count | 30 | Each package = 10 pts (3+ = max) |
| Version activity | 20 | Has latest version flag = 20 pts |
| **Total** | **100** | Capped at 100 |

A green bar (≥ 70) means actively maintained; yellow (40–69) means moderately active; grey (< 40) means stable or older.

## Implementation

- **Backend proxy**: `GET /api/mcp/registry?search=...&cursor=...&limit=...` in `src/index.js` → `handleMcp()` proxies requests to `registry.modelcontextprotocol.io/v0.1/servers`, enriches each entry with a `popularity` object, and returns the paginated response.
- **Frontend component**: `frontend/src/components/SettingsMcpRegistry.jsx` — the "Browse Registry" view with search, pagination, popularity bars, and one-tap add.
- **Router**: `#/settings/mcp/registry` route in `frontend/src/router.js`.
- **Entry point**: "Browse Registry" button in the MCP server list view bar (`frontend/src/components/SettingsMcp.jsx`).

## API

### `GET /api/mcp/registry`

Proxies the official registry's `GET /v0.1/servers` endpoint.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `search` | string | `""` | Substring search by server name |
| `cursor` | string | `""` | Pagination cursor from a previous response |
| `sort` | string | `"popularity"` | Field to sort by (`popularity`, `updatedAt`, `name`) |
| `dir` | string | `"desc"` | Sort direction (`asc`, `desc`) |
| `limit` | integer | 30 | Items per page, 1–100 |

*Note: The official registry API does not natively support sorting. Mouaif sorts only the current API response in memory before returning it to the frontend. The response is not written to app settings, project files, or a cache.*

**Response:**

```json
{
  "servers": [
    {
      "_meta": { "io.modelcontextprotocol.registry/official": { "isLatest": true, "status": "active", "updatedAt": "..." } },
      "server": { "name": "io.github.user/weather", "description": "...", "packages": [...] },
      "popularity": { "score": 78, "recencyScore": 45, "pkgScore": 20, "versionScore": 20 }
    }
  ],
  "metadata": { "count": 30, "nextCursor": "..." }
}
```
