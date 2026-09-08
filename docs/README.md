# mouaif documentation
Use these guides to install mouaif, connect accounts, secure access, and learn what the app can do.
## User guide
- [Getting started](features/getting-started.md) — install, run, update, and complete first setup.
- [Authentication](features/authentication.md) — connect AI providers and protect app access, with CLI examples.
- [App abilities](features/app-abilities.md) — projects, chats, coding tools, agents, MCP, and Inspector.
- [Chat backward pagination](features/chat-backward-pagination.md) — long chats load the newest page immediately, then eagerly load all older history in the background.
- [Draft Craft](features/draft-craft.md) — add selected code or annotated Inspector images to any chat draft.
- [Inspector Styles](features/inspector-styles.md) — tap to select an element and edit its CSS in the Inspector.
- [Restart from chat](features/chat-app-restart.md) — gracefully relaunch the app worker by asking the assistant.
- [MCP server error modal](features/mcp-error-modal.md) — inspect complete server startup failures in Settings.
- [MCP OAuth sign-in](features/mcp-oauth.md) — connect HTTP MCP servers with PKCE, keychain-backed tokens, and refresh.
- [Custom actions](features/custom-actions.md) — run project CLI commands or MCP tools from `@` mentions and the Tools popup.
- [Web preview page](features/webpreview-project-page.md) — capture and view a web URL from project settings.
- [Docker smoke test](features/docker-smoke-test.md) — build and verify mouaif in containers with a mounted example project.
- [Retry and auto-retry](features/retry-and-auto-retry.md) — retry failed turns from their error card, or let the app retry once automatically.

## Build the documentation

```bash
npm run docs:build
```

The generated public navigation links only to these user guides. Maintainer references remain in the repository for contributors but are not shown in the public navigation.
