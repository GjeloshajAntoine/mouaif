# MCP store — implementation notes

> Agent-facing reference for [`docs/features/mcp-registry-browser.md`](../../features/mcp-registry-browser.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation

- **Backend proxy**: `GET /api/mcp/registry?search=...&cursor=...&limit=...` in `src/index.js` → `handleMcp()` proxies requests to `registry.modelcontextprotocol.io/v0.1/servers`, enriches each entry with a `popularity` object, and returns the paginated response.
- **Store list**: `frontend/src/components/SettingsMcpRegistry.jsx` — debounced search-as-you-type (350 ms, stale responses dropped by a request sequence), client-side filter chips (Hosted / Local / No key) and sort (Recommended / Newest / Name), cards with Installed / Hosted / runtime / key badges, and "Load more" cursor paging that appends and de-duplicates.
- **Install sheet**: `frontend/src/components/settings/McpStoreSheet.jsx` — install option picker, API key vs OAuth for hosted servers, required fields first with optional ones folded under "More options", scope segment, then an installed state with **Start now** (`POST /api/mcp/servers/:id/start`).
- **Pure helpers**: `frontend/src/components/settings/mcpRegistryInstall.js` — `installOptions`, `summary`, `buildServerBody`, `findInstalled`, `missingRequired`, `friendlyName`, `relativeDate`. Tested by `scripts/test-mcp-registry-install.mjs`; `scripts/test-mcp-store-ui.mjs` is a manual browser fixture.
- **Router**: `#/settings/mcp/registry` entry in the table in `frontend/src/routes.js`.
- **Entry point**: primary "Browse store" button in the MCP server list view bar, plus a link in the empty-list message (`frontend/src/components/SettingsMcp.jsx`).

## Files

| File | Role |
|---|---|
| `frontend/src/components/SettingsMcpRegistry.jsx` | The store list: search, filters, sort, cards, and paging. |
| `frontend/src/components/settings/McpStoreSheet.jsx` | The install sheet (shared sheet idiom in `sheets.css`). |
| `frontend/src/components/settings/mcpRegistryInstall.js` | Pure helpers that turn a Registry entry into install options and a `POST /api/mcp/servers` body. |
| `scripts/test-mcp-registry-install.mjs` | Unit tests for the helpers. |
| `scripts/test-mcp-store-ui.mjs` | Manual browser fixture: the real store view with live Registry data and an in-memory server API. |

## From Registry entry to server config

| Registry field | mouaif config |
|---|---|
| `remotes[]` with type `streamable-http` | `transport: "http"`, `url`; `headers[]` become form fields, then `headers` |
| `remotes[]` with type `sse` | Listed, but marked as not supported |
| `packages[]` with `registryType: "npm"` | `npx -y <identifier>@<version> …` |
| `packages[]` with `registryType: "pypi"` | `uvx <identifier> …` |
| `packages[]` with `registryType: "oci"` | `docker run -i --rm -e VAR… <image> …` |
| `packages[]` with `registryType: "nuget"` | `dnx <identifier>@<version> --yes …` |
| `runtimeHint` | Replaces the default launcher |
| `runtimeArguments` / `packageArguments` | Appended to the arguments; named arguments become `--flag value` |
| `environmentVariables[]` | Form fields, then `env` |

When OAuth is selected, the `Authorization` header field is hidden and not sent, because OAuth owns that header. The install creates the server through the existing `POST /api/mcp/servers` endpoint; the store adds no new endpoint.

## Search

`GET /api/mcp/registry?search=…&cursor=…&limit=…` proxies `registry.modelcontextprotocol.io/v0.1/servers` with `version=latest`. The store waits 350 ms after the last keystroke before it sends a search. Only the newest request may update the list, so a slow response for an earlier query cannot overwrite the current results. Filters and sorting run on the loaded results in the browser.

## Popularity score

The Registry does not publish download counts or ratings, so the proxy computes a score from 0 to 100. The **Recommended** sort uses it after placing installable servers first.

| Component | Max | Source |
|---|---|---|
| Update recency | 50 | Days since `updatedAt` (full score for today, falling to 0 at 90 days) |
| Package count | 30 | 10 points per package (3 or more packages = max) |
| Version activity | 20 | 10 baseline + 10 when the `isLatest` flag is present |

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

*Note: the store no longer sends `sort`/`dir` (it sorts and filters loaded results client-side); the parameters remain supported. The official registry API does not natively support sorting. Mouaif sorts only the current API response in memory before returning it to the frontend. The response is not written to app settings, project files, or a cache.*

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
