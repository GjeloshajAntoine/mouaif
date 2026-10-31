# MCP store

## Overview

The **MCP store** lets you find and install servers from the official [MCP Registry](https://registry.modelcontextprotocol.io) like apps from an app store. Search as you type, see which servers are hosted or run locally, which need an API key and how widely each one is used, then install one from a sheet that asks only for what that server needs. Browsing is stateless: mouaif sends Registry requests through its backend and does not store or cache the responses.

## Usage

1. Open **Settings → MCP servers** (app-wide or project) and tap **Browse store**. An empty server list also links to the store.
2. Type in the search bar. Results update as you type; there is no Search button. A search needs at least 3 characters, because the Registry rejects shorter ones; with 1 or 2 typed, the list stays as it is and the store says to keep typing.
3. Narrow the list with the filter chips:
   - **Hosted** — a remote endpoint, so there is nothing to install locally.
   - **Local** — a package mouaif runs on this machine (npm, PyPI, Docker, NuGet).
   - **No key** — can be installed without typing any required value.
4. Sort with the menu at the right of the filters: **Popular** (most weekly downloads first, see [Popularity](#popularity)), **Updated** (most recently updated first), or **A–Z**. Tap **Load more servers** at the bottom to read the next page. Filters and sorting apply to the servers loaded so far: the Registry has no sort of its own and lists its 20,000+ servers alphabetically, 30 at a time, so a note above the list says how many servers the order covers. A page added with **Load more servers** goes below what you have already seen, sorted on its own, so nothing jumps in above your scroll position. Tap **Sort all** in the note to rank everything loaded as one list; picking another sort does the same.
5. Each card shows a letter avatar, the server's display name and publisher namespace, a **Get** button (**Open** when it is installed, **View** when mouaif cannot install it), a two-line description, and one quiet row of facts: **Installed** (green) when it is already configured; the usage meter and weekly downloads, for example **▂▄▆█ 205k/wk** (see [Popularity](#popularity)); **Hosted** and/or the runtime it runs with locally (**Node.js**, **Python**, **Docker**…); **Needs API key** (amber), **No key**, or **Manual setup** when no option can be installed automatically; when it was last updated; and **Deprecated** if the publisher retired it.
6. Tap anywhere on a card, or **Get**, to open the install sheet. Its header repeats the usage with the exact number (for example *204,887 npm downloads last week*), linked to the package page where the count comes from. Then:
   - **How to run it** — every way the server can run, best option first (hosted, then local packages). Hosted endpoints that only offer the older SSE transport are installable and listed after Streamable HTTP. Options mouaif cannot run, such as non-stdio local packages, are listed with the reason and cannot be selected. Local options show the exact command and the runtime it needs.
   - **Sign-in** (hosted only) — **API key** or **OAuth sign-in**. OAuth is selected by default when the server declares no headers.
   - **Required** — only the values the publisher marked as required, with their descriptions. Secret values use password fields. A value the publisher wrote as a `{token}` template (its example, meant to be substituted from the entry's `variables` map) is shown as the field's placeholder instead of its value: mouaif cannot resolve that map, so the field starts empty, the card says **Needs API key**, and Install stays disabled until you type the real value. A literal template is never sent as a header or environment variable — an empty optional field is omitted instead, so the server's own default applies.
   - **More options** — the name the server gets in mouaif, plus optional variables and headers. Values left empty use the server's own defaults.
   - **Install for** (when a project is open) — **This project** (`.mcp.json`) or **All projects** (the app store).
7. Tap **Install**. The button stays disabled until every required value is filled in. After installing:
   - **Start now** starts the server and reports how many tools it offers, or shows the start error. The first run of a local package can take a while because the package is downloaded then.
   - For OAuth servers, **Sign in** opens the server editor, where you complete the [OAuth sign-in](./mcp-oauth.md).
   - **Settings** opens the full [server editor](./mcp.md).
8. A server that is already configured shows **Installed** on its card and an **Open** button that goes to its settings. Mouaif matches a configured server when it uses the same endpoint URL or the same package.

The store is part of the settings drill-down: when it was opened from a chat, every link it builds (**Open**, **Open its settings**, the post-install **Sign in** / **Settings**) keeps that chat in context, so the editor's Back arrow returns to the chat rather than the project page.

If a server is not listed, use **Add one by hand** at the bottom of the store.

## Popularity

The MCP Registry publishes no download counts or ratings, so mouaif shows the one public usage figure that exists: **last week's downloads** of the server's package, from the npm downloads API for npm packages and from pypistats.org for PyPI packages. A server with several packages shows its most downloaded one. **Hosted** servers, and other package types (Docker, NuGet, MCPB, Cargo), have no public count, so their card shows none — mouaif never shows an invented score.

The four-bar meter reads at a glance on a log scale:

| Bars | Weekly downloads |
|---|---|
| 1 | under 1,000 |
| 2 | 1,000 – 9,999 |
| 3 | 10,000 – 99,999 (highlighted) |
| 4 | 100,000 or more (highlighted) |

**Popular** puts servers with the most weekly downloads first. Servers without a count follow, installable ones first, then the most recently updated. Downloads measure installs, not quality, and include CI and mirrors. Treat them as a sign of how widely a package is used, not as an endorsement.

If npm or PyPI is slow or unreachable, the store still loads: the affected cards show no count. Counts are fetched by mouaif's backend and kept in memory for six hours, so typing a search letter by letter does not ask npm again for the same packages.

## Trust

Anyone can publish to the Registry. The store says so in its footer. Local packages run with the permissions of the mouaif process, so install only servers you trust. Project-scoped installs write any secret values you enter to `.mcp.json`. Review that file before committing it, or install the server for **All projects** instead.
