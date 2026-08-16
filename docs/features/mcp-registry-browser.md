# MCP Registry Browser

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
