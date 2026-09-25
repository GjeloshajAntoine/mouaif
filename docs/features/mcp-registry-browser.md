# MCP store

## Overview

The **MCP store** lets you find and install servers from the official [MCP Registry](https://registry.modelcontextprotocol.io) like apps from an app store. Search as you type, see which servers are hosted or run locally and which need an API key, then install one from a sheet that asks only for what that server needs. Browsing is stateless: mouaif sends Registry requests through its backend and does not store or cache the responses.

## Usage

1. Open **Settings → MCP servers** (app-wide or project) and tap **Browse store**. An empty server list also links to the store.
2. Type in the search bar. Results update as you type; there is no Search button.
3. Narrow the list with the filter chips:
   - **Hosted** — a remote endpoint, so there is nothing to install locally.
   - **Local** — a package mouaif runs on this machine (npm, PyPI, Docker, NuGet).
   - **No key** — can be installed without typing any required value.
4. Sort by **Recommended** (servers mouaif can install first, then the most actively maintained — the Registry publishes no download counts, so mouaif scores recent updates and package count), **Newest**, or **Name A–Z**. Tap **Load more servers** at the bottom to read the next page.
5. Each card shows a letter avatar, the server's display name, its publisher namespace, when it was last updated, a two-line description, and badges: **Installed**, **Hosted**, the runtime (for example **Node.js (npx)**), **Needs API key** / **No key**, **Manual setup**, or **Deprecated**.
6. Tap a card or **Get** to open the install sheet:
   - **How to run it** — every way the server can run, best option first (hosted, then local packages). Hosted endpoints that only offer the older SSE transport are installable and listed after Streamable HTTP. Options mouaif cannot run, such as non-stdio local packages, are listed with the reason and cannot be selected. Local options show the exact command and the runtime it needs.
   - **Sign-in** (hosted only) — **API key** or **OAuth sign-in**. OAuth is selected by default when the server declares no headers.
   - **Required** — only the values the publisher marked as required, with their descriptions. Secret values use password fields.
   - **More options** — the name the server gets in mouaif, plus optional variables and headers. Values left empty use the server's own defaults.
   - **Install for** (when a project is open) — **This project** (`.mcp.json`) or **All projects** (the app store).
7. Tap **Install**. The button stays disabled until every required value is filled in. After installing:
   - **Start now** starts the server and reports how many tools it offers, or shows the start error. The first run of a local package can take a while because the package is downloaded then.
   - For OAuth servers, **Sign in** opens the server editor, where you complete the [OAuth sign-in](./mcp-oauth.md).
   - **Settings** opens the full [server editor](./mcp.md).
8. A server that is already configured shows **Installed** on its card and an **Open** button that goes to its settings. Mouaif matches a configured server when it uses the same endpoint URL or the same package.

If a server is not listed, use **Add one by hand** at the bottom of the store.

## Trust

Anyone can publish to the Registry. The store says so in its footer. Local packages run with the permissions of the mouaif process, so install only servers you trust. Project-scoped installs write any secret values you enter to `.mcp.json`. Review that file before committing it, or install the server for **All projects** instead.
