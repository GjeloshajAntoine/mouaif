# mouaif documentation

The published site is served by GitHub Pages from `docs/` on `master`. Start with the **User guide**; every other page is a reference for one feature. Maintainer material (architectural decisions and implementation notes) stays in the repository and is never published.

## User guide

The guides linked from the site navigation.

- [Getting started](features/getting-started.md) — step-by-step install, first login, provider, project, and chat; phone access, update, uninstall, and troubleshooting.
- [CLI commands](features/cli-commands.md) — every `mouaif` command, `serve` option, and environment variable, with recipes.
- [Authentication](features/authentication.md) — require a login to open mouaif, with CLI examples.
- [App abilities](features/app-abilities.md) — projects, chats, coding tools, agents, MCP, and Inspector.
- [Draft Craft](features/draft-craft.md) — add selected code, annotated images, or Inspector entries to any chat draft.

## Reference

One page per feature: what it does and how to use it.

### Install and access

- [npm package](features/npm-package.md) — the published package, what an install contains, and the release flow.
- [Login notification](features/login-notification.md) — a browser alert on a new sign-in, sent to every subscribed device.
- [Push notifications](features/push-notifications.md) — follow a running chat and answer approvals from a notification.
- [Install as an app](features/pwa.md) — install the web app, the offline shell, and the update prompt.
- [Restart from chat](features/chat-app-restart.md) — ask the assistant to relaunch the app worker.
- [Restart API](features/restart-api.md) — restart the worker from a script with `POST /api/restart`.

### Providers and models

- [AI providers](features/providers.md) — connect the providers mouaif calls, and where their credentials are kept.
- [Cloud model providers](features/cloud-providers.md) — Azure OpenAI, Mistral, Groq, and DeepSeek.
- [Local OpenAI-compatible servers](features/local-openai-servers.md) — connect llama.cpp's `llama-server` or LM Studio with no API key.
- [OpenRouter](features/openrouter.md) — one key for many upstream models, with browser sign-in.
- [Anthropic sign-in](features/oauth-anthropic.md) — sign in with an Anthropic account instead of an API key.
- [GitHub Copilot](features/github-copilot.md) — chat with your Copilot plan's models after a one-time-code GitHub sign-in.
- [Model picker](features/model-picker.md) — search, filter by provider, and switch the chat's model.
- [Model bookmarks](features/model-bookmarks.md) — pinned and recently used models at the top of the picker.
- [Thinking level](features/thinking-level.md) — choose how much the model reasons, when the provider supports it.
- [Max output tokens](features/max-output-tokens.md) — cap how many tokens a model may write per turn.
- [Prompt caching](features/prompt-caching.md) — how cached prompt prefixes lower Anthropic costs.
- [Usage metrics](features/usage-metrics.md) — per-turn cost and live token speed in the chat.

### Projects and settings

- [Project card](features/project-card.md) — each project's chats, New chat, and options menu on the Chats tab.
- [Project card search](features/project-card-search.md) — the magnifier on a project card: search that project's chats, drafts, and messages.
- [New-project folder picker](features/folder-picker.md) — browse to a folder or create one to add a project.
- [Projects in Settings](features/projects-in-settings.md) — the registered projects listed under Settings.
- [App and project settings](features/app-and-project-settings.md) — defaults, app settings, and project overrides.
- [Project settings storage](features/project-settings-storage.md) — keep settings in `.mouaif.json` or in the app store.
- [Settings](features/settings-ui.md) — the Settings tab and what each section controls.
- [Custom prompts](features/custom-prompts.md) — reusable system prompts at app and project scope.
- [Prompt-size profiles](features/prompt-profiles.md) — `very-small`, `average`, `extensive`, and `chat` system prompts.
- [Agents](features/agents.md) — named personas the model can delegate work to.
- [Agent file picker](features/agent-file-picker.md) — choose which instruction files (`AGENTS.md`, …) a project reads.
- [Skills](features/skills.md) — reusable instruction sets discovered from `.agents/skills/`.
- [Custom actions](features/custom-actions.md) — run project CLI commands or MCP tools from `@` mentions and the Tools popup.
- [File tagging](features/file-tagging.md) — tag project files so they are included in a chat.
- [Hide file content](features/hide-file-content.md) — mark lines or text the agent file tools must not reveal.

### Chat

- [Chat](features/chat-ui.md) — the conversation view, composer, and per-chat controls.
- [Chat scroll navigation](features/chat-scroll-nav.md) — arrows to step to the previous / next message or jump to the bottom.
- [Chat switcher](features/chat-switcher.md) — jump between a project's chats from the chat header.
- [@-mentions](features/at-mention.md) — insert files, agents, actions, and tools from the composer.
- [Message copy](features/message-copy.md) — copy any message with one tap.
- [Retry and auto-retry](features/retry-and-auto-retry.md) — retry a failed turn, or let the app retry once automatically.
- [Chat error surfacing](features/chat-error-surfacing.md) — how a failed request shows up in the chat.
- [Trace to file](features/trace.md) — save a chat's events to a file in the project.
- [Dictation](features/dictation.md) — speech-to-text from a Settings page and from the composer microphone.
- [Composer tool buttons](features/composer-tool-buttons.md) — show or hide the microphone, image button and composer status line.
- [File button: glass orb](features/file-button-orb.md) — an optional animated look for the composer's file button.
- [File toolbar](features/file-toolbar.md) — the composer menu for Files, Git, and the CLI.
- [Files modal](features/files-modal-text-and-images.md) — edit any text file and preview images.
- [CLI modal](features/cli-modal.md) — a terminal inside the chat that can answer interactive prompts.
- [Background terminal](features/background-terminal.md) — the CLI shell keeps running after you close the sheet; reopen to replay its output.

### Tools and approvals

- [Tool authorization](features/tool-authorization.md) — Off, Ask, and Allow for every tool, and the approval card.
- [Tool popup](features/tool-popup.md) — change tool visibility and approval mode from the chat header.
- [Tool tree](features/tool-tree.md) — the list of tools with their checkboxes and approval modes.
- [Tool card expanded view](features/tool-card-expanded-view.md) — what an expanded tool card shows.
- [Live tool preview](features/live-tool-preview.md) — live tool output when you return to a running chat.
- [Shell tool](features/shell-tool.md) — the model runs commands in the project and reads the output.
- [File tools](features/file-tools.md) — the model lists, searches, reads, and edits project files.
- [Opening images with `read_file`](features/read-file-images.md) — the model looks at a picture and the card shows it.
- [Project search](features/search-engine.md) — how `search_files` searches the project.
- [Ask the user tool](features/ask-user-tool.md) — the model pauses to ask a question with options.
- [Task tool](features/task-tool.md) — the model tracks work as tasks with progress.
- [Progress tool](features/progress-tool.md) — a live progress bar for long operations.
- [Legacy progress tool](features/legacy-progress-tool.md) — compatibility for older `report_progress` calls.
- [Web preview tool](features/webpreview.md) — a phone-sized screenshot of a page above the composer.
- [Web preview page](features/webpreview-project-page.md) — capture and view a URL from project settings.
- [Subagent transcript](features/subagent-transcript.md) — the delegated conversation inside a subagent card.
- [Model choice on subagent approval](features/auth-model-picker.md) — pick the model when approving a subagent run.
- [Tool output profile](features/tool-output.md) — how much of each tool result is sent back to the model.
- [Tool feedback compaction](features/tool-feedback-compaction.md) — large results stay complete in the chat but are trimmed for the model.
- [Agent feature prompt](features/agent-feature-prompt.md) — how the model learns which features are enabled.

### MCP

- [MCP servers](features/mcp.md) — connect Model Context Protocol servers as extra tools.
- [MCP OAuth sign-in](features/mcp-oauth.md) — browser sign-in or client credentials for remote MCP servers, with remote revocation.
- [MCP store](features/mcp-registry-browser.md) — search, filter, and install servers from the public MCP Registry in a few taps.
- [MCP server error modal](features/mcp-error-modal.md) — read a server's full startup error in Settings.
- [Chrome Debug MCP](features/chrome-debug-mcp.md) — let the model drive the debug browser.

### Inspector

- [Inspector](features/inspector.md) — the mobile DevTools tab: preview, console, network, and tabs.
- [Inspector Chrome profiles](features/inspector-profiles.md) — choose which Chrome profile the Inspector attaches to.
- [Inspector target bar](features/inspector-target-origin.md) — which element, which rule, and where an edit lands.
- [Inspector full screen](features/inspector-fullscreen.md) — expand one panel over the whole screen.
- [Inspector JavaScript console](features/inspector-js-console.md) — run JavaScript in the inspected page.
- [Add Inspector entries to a chat](features/inspector-add-to-chat.md) — send a log, exception, or request to a chat draft.
- [Inspector Styles](features/inspector-styles.md) — tap an element and edit its CSS.
- [Inspector touch controls](features/inspector-touch-controls.md) — chips, sliders, a box model, and swatches for CSS.
- [Inspector value types](features/inspector-value-types.md) — switch a value between length, number, percentage, and keyword.
- [Inspector value suggestions](features/inspector-value-suggestions.md) — values and design tokens the page already uses.
- [Inspector value rail](features/inspector-value-rail.md) — one numeric control for every kind of value.
- [Inspector intent](features/inspector-intent.md) — describe a change in words and review the proposed edits.
- [Inspector non-destructive editing](features/inspector-non-destructive-editing.md) — what an edit changes and how to undo it.

## How it works

Published pages about how the app is built. They are reachable by URL but not listed on the site.

- [Assistant server and CLI](features/rest-and-sse-server.md) — the local server, its REST and SSE surface.
- [AI client](features/ai-client.md) — the server-side proxy that talks to providers and streams replies.
- [Chat storage](features/chat-storage.md) — chats and messages in the app SQLite store.
- [Chat load performance](features/chat-load-performance.md) — how long chats open quickly.
- [Chat backward pagination](features/chat-backward-pagination.md) — newest page first, older history in the background.
- [Chat streaming performance](features/chat-streaming-performance.md) — incremental rendering while a reply streams.
- [Memory footprint and payload size](features/memory-footprint.md) — lazy server dependencies, bounded caches, compressed assets.
- [Chat transcript rendering](features/chat-transcript-rendering.md) — unchanged rows are reused instead of rebuilt.
- [Run settle latch](features/run-settle-latch.md) — no status flicker when returning to a finished run.
- [iOS touch scroll](features/ios-touch-scroll.md) — the transcript scrolls with a finger on iOS Safari.
- [Flush-route scrolling](features/flush-route-scroll.md) — every settings sub-page scrolls to the bottom on a phone.
- [Virtual list](features/virtual-list.md) — the windowed list behind long lists.
- [Markdown renderer](features/markdown-renderer.md) — the safe renderer for chat messages.
- [Lazy-loaded settings](features/frontend-lazy-settings.md) — settings pages load on demand for a faster first paint.
- [Responsive layout](features/responsive-layout.md) — how the phone layout grows on tablet and desktop.
- [Routing](features/routing.md) — every hash the app answers and its parameters.
- [Modal sheets](features/modal-sheets.md) — shared Escape, Tab, and focus behavior for full-screen sheets.
- [Content Security Policy](features/content-security-policy.md) — the policy the app shell ships with.
- [Docker smoke test](features/docker-smoke-test.md) — build and verify mouaif in containers.
- [Documentation site](features/docs-site.md) — how this site is built and published, and the landing screenshots.

## Maintainer notes

Kept in the repository for contributors and never published.

- [Architectural decisions](decisions.md) — the numbered decision log.
- `agent/features/<slug>.md` — implementation notes for each feature page: source files, data shapes, endpoints, and tests.

## Build the documentation

```bash
npm run docs:build            # public site -> docs-dist/
npm run docs:build:internal   # + maintainer pages (decisions, agent notes)
npm run docs:publish          # sync the public site into docs/ for GitHub Pages
npm run docs:shots            # re-capture the landing page screenshots
npm run docs:shots:draft-craft # re-capture the Draft Craft guide screenshots
```

See [Documentation site](features/docs-site.md) for what is published and how GitHub Pages deploys it.
