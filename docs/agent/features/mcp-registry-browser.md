# MCP store — implementation notes

> Agent-facing reference for [`docs/features/mcp-registry-browser.md`](../../features/mcp-registry-browser.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation

- **Backend proxy**: `GET /api/mcp/registry?search=...&cursor=...&limit=...` in `src/index.js` → `handleMcp()` proxies requests to `registry.modelcontextprotocol.io/v0.1/servers`, attaches each entry's weekly package downloads as `downloads` (`src/mcpDownloads.js`), and returns the paginated response.
- **Store list**: `frontend/src/components/SettingsMcpRegistry.jsx` — debounced search-as-you-type (350 ms, stale responses dropped by a request sequence), client-side filter chips (Hosted / Local / No key) and a sort menu pinned beside them (Popular / Updated / A–Z), cards with a header row (avatar, name + publisher, one CTA), a full-width description, and a fact row (Installed, usage meter, Hosted / runtime, key, updated), and "Load more" cursor paging that appends and de-duplicates.
- **Usage meter**: `frontend/src/components/settings/McpPopularity.jsx` — four log-scale bars plus `205k/wk` on cards, the spelled-out count in the sheet (`detail`); renders nothing without a count. Helpers `weeklyDownloads`, `compactCount`, `popularityLevel`, `downloadsLabel` live in `mcpRegistryInstall.js`.
- **Install sheet**: `frontend/src/components/settings/McpStoreSheet.jsx` — install option picker, API key vs OAuth for hosted servers, required fields first with optional ones folded under "More options", scope segment, then an installed state with **Start now** (`POST /api/mcp/servers/:id/start`).
- **Pure helpers**: `frontend/src/components/settings/mcpRegistryInstall.js` — `installOptions`, `summary`, `buildServerBody`, `findInstalled`, `missingRequired`, `friendlyName`, `relativeDate`, and the placeholder resolution `isTemplate` / `fieldValue`. Tested by `scripts/test-mcp-registry-install.mjs`; `scripts/test-mcp-store-ui.mjs` is a manual browser fixture.
- **Request wiring**: `scripts/test-mcp-registry-search.js` loads `SettingsMcpRegistry.jsx` through a faithful module loader (each file runs in its own scope, imports become real bindings) and asserts the view fetches both `/api/mcp/registry` and the project-scoped `/api/mcp/servers?projectDir=…`, including a typed search. A local helper the view calls without importing it is not in scope, so the test reproduces the browser's `ReferenceError` instead of a green build hiding it.
- **Context forwarding**: the registry route carries `projectDir`, `chatId`, and `from` (the same context every settings drill-down passes down). The view forwards all three into `McpStoreSheet`, and both the view and the sheet pass `chatId` to `editorHref()` on every editor link (Installed card **Open**, the sheet's "Open its settings", and the post-install **Sign in** / **Settings**). Losing `chatId` makes the MCP editor's Back arrow walk to project settings or the Settings root instead of the chat the store was opened from; `scripts/test-mcp-registry-search.js` asserts the links keep it.
- **Router**: `#/settings/mcp/registry` entry in the table in `frontend/src/routes.js`.
- **Entry point**: primary "Browse store" button in the MCP server list view bar, plus a link in the empty-list message (`frontend/src/components/SettingsMcp.jsx`).

## Files

| File | Role |
|---|---|
| `frontend/src/components/SettingsMcpRegistry.jsx` | The store list: search, filters, sort, cards, and paging. |
| `src/mcpDownloads.js` | Weekly npm / PyPI download lookups with an in-memory cache. |
| `frontend/src/components/settings/McpPopularity.jsx` | The usage meter on cards and in the sheet. |
| `frontend/src/components/settings/mcpStoreSort.js` | Pure search and sort rules: `searchTerm` (3-character minimum), `sortKeys`, `compareKeys`, `orderRows` (per-block ranking). |
| `scripts/test-mcp-store-sort.mjs` | Unit tests for those rules. |
| `scripts/test-mcp-downloads.js` | Unit tests for the lookups (fake fetch) and the count formatting. |
| `frontend/src/components/settings/McpStoreSheet.jsx` | The install sheet (shared sheet idiom in `sheets.css`). |
| `frontend/src/components/settings/mcpRegistryInstall.js` | Pure helpers that turn a Registry entry into install options and a `POST /api/mcp/servers` body. |
| `scripts/test-mcp-registry-install.mjs` | Unit tests for the helpers. |
| `scripts/test-mcp-registry-search.js` | Renders the store through a scope-faithful module loader and asserts it fetches registry results (including a typed search) and the project-scoped configured servers. |
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

`GET /api/mcp/registry?search=…&cursor=…&limit=…` proxies `registry.modelcontextprotocol.io/v0.1/servers` with `version=latest`. `v0.1` is the current Registry API (the live OpenAPI lists only `/v0` and `/v0.1`; service build 1.8.7, checked 2026-10-31). The store waits 350 ms after the last keystroke before it sends a search. Only the newest request may update the list, so a slow response for an earlier query cannot overwrite the current results. Filters and sorting run on the loaded results in the browser.

The Registry rejects a search shorter than 3 characters after trimming (HTTP 422). `searchTerm()` turns 1–2 characters into "no search", the effect is keyed on that term (so typing "g", "gi" sends nothing), and the view shows *Type at least 3 characters to search.* The proxy also answers such a search with `400 { error: "Search needs at least 3 characters." }` instead of relaying the 422.

## Sorting

The Registry API has no sort parameter: it pages servers alphabetically by id (`sort=` is silently ignored), and the upstream "sorting signals" proposal (modelcontextprotocol/registry#94) was closed as not planned in April 2026. A global ranking would mean crawling the whole catalogue (20,000+ servers, 200+ pages) plus thousands of npm lookups, so the store ranks only what it has loaded and says so:

- `infos` (memo on `entries`) computes `summary()` and `sortKeys()` once per entry; the comparator only reads those keys. Before this, the comparator rebuilt an `Intl.Collator` and parsed install options on every comparison — 4,132 `summary()` calls and ~60 ms for 300 entries, against ~4 ms precomputed.
- `blockStarts` records where each **Load more** page begins. `orderRows()` sorts within each block and keeps blocks in load order, so a new page's most popular servers do not land above the reader's scroll position. **Sort all** in the note (or picking a sort) resets it to `[0]`, one ranking.
- The note above the list reads *Sorted among the N servers loaded so far* while more pages exist, or *New pages are added below, each sorted on its own* with the **Sort all N** button once there are several blocks.

## Popularity (weekly downloads)

The Registry publishes no download counts or ratings. The previous computed "popularity score" (recency + package count + a near-constant version term) was dropped: it ranked by freshness while its label implied usage. `src/mcpDownloads.js` `weeklyDownloads(entries)` now looks up real counts:

| Source | Request | Notes |
|---|---|---|
| npm, unscoped | `api.npmjs.org/downloads/point/last-week/a,b,…` | Bulk, ≤100 names per call. A single name uses the per-package form, because npm answers a one-name bulk call in the single-package shape. |
| npm, scoped | `api.npmjs.org/downloads/point/last-week/@scope%2Fname` | One call each; npm has no scoped bulk form. |
| PyPI | `pypistats.org/api/packages/<name>/recent?period=week` → `data.last_week` | Names normalised per PEP 503 (lowercase, runs of `-_.` → `-`). |

- At most 6 requests in flight, 2.5 s timeout each; a lookup that fails gives `downloads: null`, never a 502 for the page.
- In-memory cache keyed `npm:<name>` / `pypi:<name>`: 6 h for answers (including "no such package"), 5 min for failures, 3000 keys max (oldest evicted). Nothing is written to disk, and Registry responses themselves are still not cached.
- An entry with several countable packages reports its most downloaded one.
- OCI, NuGet, MCPB, Cargo and hosted-only entries get `null`.

Client sort **Popular** (`compareKeys('popularity')` in `mcpStoreSort.js`): weekly downloads desc; entries without a count after, installable first, then `updatedAt` desc. Like the other sorts it ranks the loaded pages only — the Registry API offers no server-side sort.

## Placeholder values (`{token}`)

A Registry input (`KeyValueInput`) can carry a `value` with `{name}` tokens that the registry substitutes from the input's `variables` map. mouaif reads the `value`/`default` fields but not `variables`, so such a value is the publisher's example, not a value:

- `isTemplate(value)` (`mcpRegistryInstall.js`) tests for `{…}`; `toField()` sets `template: true`.
- `fieldValue(field, values)` returns the user's typed value, else the default, and `''` for a template.
- `summary()` uses `fieldValue` for `needsKey`, so Smithery-style rows read **Needs API key** instead of being silently "no key".
- `missingRequired()` and `buildServerBody()` use `fieldValue`, so the sheet disables Install and a literal `Bearer {smithery_api_key}` is never written into `headers`/`env` — an empty optional field is omitted so the server default applies.
- `McpStoreSheet.fieldRow()` renders the template text as the input's `placeholder` plus a hint, with an empty value.
- `summary().option` is the option the sheet opens on (an option with nothing to fill in beats one that asks for a key), which is what `McpStoreSheet` seeds `optionKey` and the sign-in segment from — so the card's badges and the sheet's first section agree.

Example (real Smithery entry):

```json
{ "name": "Authorization", "value": "Bearer {smithery_api_key}", "isRequired": true, "isSecret": true }
```

## API

### `GET /api/mcp/registry`

Proxies the official registry's `GET /v0.1/servers` endpoint.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `search` | string | `""` | Substring search by server name; empty, or at least 3 characters after trimming |
| `cursor` | string | `""` | Pagination cursor from a previous response |
| `limit` | integer | 30 | Items per page, 1–100 |

*Servers are returned in the Registry's order (alphabetical by id) with `downloads` added; the proxy no longer takes `sort`/`dir`, because sorting one page of a cursor-paged list ranks nothing — the store sorts what it has loaded (see [Sorting](#sorting)). A `search` of 1–2 characters gets `400`. The response is not written to app settings, project files, or a cache.*

**Response:**

```json
{
  "servers": [
    {
      "_meta": { "io.modelcontextprotocol.registry/official": { "isLatest": true, "status": "active", "updatedAt": "..." } },
      "server": { "name": "io.github.user/weather", "description": "...", "packages": [...] },
      "downloads": { "weekly": 204887, "source": "npm", "package": "@modelcontextprotocol/server-github" }
    }
  ],
  "metadata": { "count": 30, "nextCursor": "..." }
}
```
