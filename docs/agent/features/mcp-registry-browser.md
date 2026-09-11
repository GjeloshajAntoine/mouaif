# MCP Registry Browser — implementation notes

> Agent-facing reference for [`docs/features/mcp-registry-browser.md`](../../features/mcp-registry-browser.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation

- **Backend proxy**: `GET /api/mcp/registry?search=...&cursor=...&limit=...` in `src/index.js` → `handleMcp()` proxies requests to `registry.modelcontextprotocol.io/v0.1/servers`, enriches each entry with a `popularity` object, and returns the paginated response.
- **Frontend component**: `frontend/src/components/SettingsMcpRegistry.jsx` — the "Browse Registry" view with search, pagination, popularity bars, and one-tap add.
- **Router**: `#/settings/mcp/registry` entry in the table in `frontend/src/routes.js`.
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
