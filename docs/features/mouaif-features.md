# mouaif feature reference

## Overview

Every feature mouaif ships, in one page, with a link to the full page for each one. It is written to be pasted into an AI assistant: give your agent this URL and it can look up what the app can do instead of guessing.

## How to use this page

- Point an agent at the published URL — `https://gjeloshajantoine.github.io/mouaif/features/mouaif-features.html` — and ask it about a feature by name.
- Working from a checkout? Hand the agent the file itself: `docs/features/mouaif-features.md`.
- Each entry is one line: a link to its page, then what it does. Follow the link when the summary is not enough.
- The overview pages below are the fastest start: they cover setup, the CLI, access control, and the app as a whole.

## User guide

- [Getting started](getting-started.md) — install, first login, provider, project, and chat; phone access, update, uninstall, and troubleshooting.
- [CLI commands](cli-commands.md) — every `mouaif` command, `serve` option, and environment variable, with recipes.
- [Authentication](authentication.md) — require a login before the app opens.
- [App abilities](app-abilities.md) — projects, chats, coding tools, agents, MCP, and Inspector in one tour.
- [Draft Craft](draft-craft.md) — add selected code, annotated images, or Inspector entries to any chat draft.

## Install and access

- [npm package](npm-package.md) — the published package, what an install contains, and the release flow.
- [Login notification](login-notification.md) — a browser alert on a new sign-in, sent to every subscribed device.
- [Push notifications](push-notifications.md) — follow a running chat and answer approvals from a notification.
- [Install as an app](pwa.md) — install the web app, the offline shell, and the update prompt.
- [Restart from chat](chat-app-restart.md) — ask the assistant to relaunch the app worker.
- [Restart API](restart-api.md) — restart the worker from a script with `POST /api/restart`.

## Providers and models

- [AI providers](providers.md) — connect the providers mouaif calls, and where their credentials are kept.
- [Cloud model providers](cloud-providers.md) — Azure OpenAI, Mistral, Groq, and DeepSeek.
- [Local OpenAI-compatible servers](local-openai-servers.md) — connect llama.cpp's `llama-server` or LM Studio with no API key.
- [OpenRouter](openrouter.md) — one key for many upstream models, with browser sign-in.
- [Anthropic sign-in](oauth-anthropic.md) — sign in with an Anthropic account instead of an API key.
- [GitHub Copilot](github-copilot.md) — chat with your Copilot plan's models after a one-time-code GitHub sign-in.
- [Model picker](model-picker.md) — search, filter by provider, and switch the chat's model.
- [Model bookmarks](model-bookmarks.md) — pinned and recently used models at the top of the picker.
- [Thinking level](thinking-level.md) — choose how much the model reasons, when the provider supports it.
- [Max output tokens](max-output-tokens.md) — cap how many tokens a model may write per turn.
- [Prompt caching](prompt-caching.md) — how cached prompt prefixes lower Anthropic costs.
- [Usage metrics](usage-metrics.md) — per-turn cost, live token speed, and the account **Balance** chip.

## Projects and settings

- [Project card](project-card.md) — each project's chats, New chat, and options menu on the Chats tab.
- [Project card search](project-card-search.md) — the magnifier on a project card: search that project's chats, drafts, and messages.
- [New-project folder picker](folder-picker.md) — browse to a folder or create one to add a project, and choose where its settings live.
- [Projects in Settings](projects-in-settings.md) — the registered projects listed under Settings.
- [App and project settings](app-and-project-settings.md) — defaults, app settings, and project overrides.
- [Project settings storage](project-settings-storage.md) — keep settings in `.mouaif.json` or in the app store.
- [Settings](settings-ui.md) — the Settings tab and what each section controls.
- [Settings back navigation](settings-back-navigation.md) — where the Back arrow of every settings page goes, and why.
- [Custom prompts](custom-prompts.md) — reusable system prompts at app and project scope.
- [Prompt-size profiles](prompt-profiles.md) — `very-small`, `average`, `extensive`, and `chat` system prompts.
- [Agents](agents.md) — named personas the model can delegate work to.
- [Agent file picker](agent-file-picker.md) — choose which instruction files (`AGENTS.md`, …) a project reads.
- [Skills](skills.md) — reusable instruction sets discovered from `.agents/skills/`.
- [Custom actions](custom-actions.md) — run project CLI commands or MCP tools from `@` mentions and the Tools popup.
- [File tagging](file-tagging.md) — tag project files so they are included in a chat.
- [Hide file content](hide-file-content.md) — mark lines or text the agent file tools must not reveal.

## Chat

- [Chat](chat-ui.md) — the conversation view, composer, and per-chat controls.
- [Chat scroll navigation](chat-scroll-nav.md) — arrows to step to the previous / next message or jump to the bottom.
- [Chat switcher](chat-switcher.md) — jump between a project's chats from the chat header.
- [@-mentions](at-mention.md) — insert files, agents, actions, and tools from the composer.
- [Message copy](message-copy.md) — copy any message with one tap.
- [Full-screen images in the chat](chat-image-zoom.md) — tap any picture to open it full screen.
- [Touch taps](touch-taps.md) — every control answers a single tap on a phone; hover styling is scoped to mouse devices.
- [Retry and auto-retry](retry-and-auto-retry.md) — retry a failed turn, or let the app retry once automatically.
- [Chat error surfacing](chat-error-surfacing.md) — how a failed request shows up in the chat.
- [Trace to file](trace.md) — save a chat's events to a file in the project.
- [Dictation](dictation.md) — speech-to-text from a Settings page and from the composer microphone.
- [Composer tool buttons](composer-tool-buttons.md) — show or hide the microphone, image button and composer status line.
- [File button: glass orb](file-button-orb.md) — an optional animated look for the composer's file button.
- [File toolbar](file-toolbar.md) — the composer menu for Files, Git, and the CLI.
- [Files modal](files-modal-text-and-images.md) — edit any text file and preview images.
- [CLI modal](cli-modal.md) — a terminal inside the chat that can answer interactive prompts.
- [Background terminal](background-terminal.md) — the CLI shell keeps running after you close the sheet; reopen to replay its output.

## Tools and approvals

- [Tool authorization](tool-authorization.md) — Off, Ask, and Allow for every tool, and the approval card.
- [Tool popup](tool-popup.md) — change tool visibility and approval mode from the chat header.
- [Tool tree](tool-tree.md) — the list of tools with their checkboxes and approval modes.
- [Tool card expanded view](tool-card-expanded-view.md) — what an expanded tool card shows, for every tool type.
- [Live tool preview](live-tool-preview.md) — live tool output when you return to a running chat.
- [Shell tool](shell-tool.md) — the model runs commands in the project and reads the output.
- [File tools](file-tools.md) — the model lists, searches, reads, and edits project files.
- [Grouped file tools](grouped-file-tools.md) — read several files or apply several block replacements in one call.
- [Opening images with `read_file`](read-file-images.md) — the model looks at a picture and the card shows it.
- [Project search](search-engine.md) — how `search_files` searches the project.
- [Ask the user tool](ask-user-tool.md) — the model pauses to ask a question with options.
- [Task tool](task-tool.md) — the model tracks work as tasks with progress.
- [Progress tool](progress-tool.md) — a live progress bar for long operations.
- [Legacy progress tool](legacy-progress-tool.md) — compatibility for older `report_progress` calls.
- [Web preview tool](webpreview.md) — a phone-sized screenshot of a page above the composer.
- [Web preview page](webpreview-project-page.md) — capture and view a URL from project settings.
- [Subagent transcript](subagent-transcript.md) — the delegated conversation inside a subagent card, and what that run cost.
- [Model choice on subagent approval](auth-model-picker.md) — pick the model when approving a subagent run.
- [Tool output profile](tool-output.md) — how much of each tool result is sent back to the model.
- [Tool feedback compaction](tool-feedback-compaction.md) — large results stay complete in the chat but are trimmed for the model.
- [Agent feature prompt](agent-feature-prompt.md) — how the model learns which features are enabled.

## MCP

- [MCP servers](mcp.md) — connect Model Context Protocol servers as extra tools.
- [MCP OAuth sign-in](mcp-oauth.md) — browser sign-in or client credentials for remote MCP servers, with remote revocation.
- [MCP store](mcp-registry-browser.md) — search, filter, and install servers from the public MCP Registry in a few taps.
- [MCP server error modal](mcp-error-modal.md) — read a server's full startup error in Settings.
- [Chrome Debug MCP](chrome-debug-mcp.md) — let the model drive the debug browser.

## Inspector

- [Inspector](inspector.md) — the mobile DevTools tab: preview, console, network, and tabs.
- [Inspector Chrome profiles](inspector-profiles.md) — choose which Chrome profile the Inspector attaches to.
- [Inspector target bar](inspector-target-origin.md) — which element, which rule, and where an edit lands.
- [Inspector full screen](inspector-fullscreen.md) — expand one panel over the whole screen.
- [Inspector JavaScript console](inspector-js-console.md) — run JavaScript in the inspected page.
- [Add Inspector entries to a chat](inspector-add-to-chat.md) — send a log, exception, or request to a chat draft.
- [Inspector Styles](inspector-styles.md) — tap an element and edit its CSS.
- [Inspector touch controls](inspector-touch-controls.md) — chips, sliders, a box model, and swatches for CSS.
- [Inspector touch value editing](inspector-touch-values.md) — suggested values, choose/convert units, and numeric parts for compound CSS.
- [Inspector value types](inspector-value-types.md) — switch a value between length, number, percentage, and keyword.
- [Inspector value suggestions](inspector-value-suggestions.md) — values and design tokens the page already uses.
- [Inspector value rail](inspector-value-rail.md) — one numeric control for every kind of value.
- [Inspector intent](inspector-intent.md) — describe a change in words and review the proposed edits.
- [Inspector non-destructive editing](inspector-non-destructive-editing.md) — what an edit changes and how to undo it.

## How it works

- [Assistant server and CLI](rest-and-sse-server.md) — the local server, its REST and SSE surface.
- [AI client](ai-client.md) — the server-side proxy that talks to providers and streams replies.
- [Chat storage](chat-storage.md) — chats and messages in the app SQLite store.
- [Chat load performance](chat-load-performance.md) — how long chats open quickly.
- [Chat backward pagination](chat-backward-pagination.md) — newest page first, older history in the background.
- [Chat streaming performance](chat-streaming-performance.md) — incremental rendering while a reply streams.
- [Memory footprint and payload size](memory-footprint.md) — lazy server dependencies, bounded caches, compressed assets.
- [Chat transcript rendering](chat-transcript-rendering.md) — unchanged rows are reused instead of rebuilt.
- [Chat row identity](chat-client-row-ids.md) — messages shown before they are saved carry an id, so the saved copy replaces them exactly.
- [Run settle latch](run-settle-latch.md) — no status flicker when returning to a finished run.
- [iOS touch scroll](ios-touch-scroll.md) — the transcript scrolls with a finger on iOS Safari.
- [Flush-route scrolling](flush-route-scroll.md) — every settings sub-page scrolls to the bottom on a phone.
- [Virtual list](virtual-list.md) — the windowed list behind long lists.
- [Markdown renderer](markdown-renderer.md) — the safe renderer for chat messages.
- [Lazy-loaded settings](frontend-lazy-settings.md) — settings pages load on demand for a faster first paint.
- [Responsive layout](responsive-layout.md) — how the phone layout grows on tablet and desktop.
- [Routing](routing.md) — every hash the app answers and its parameters.
- [Modal sheets](modal-sheets.md) — shared Escape, Tab, and focus behavior for full-screen sheets.
- [Design tokens and shared UI styles](design-tokens.md) — the CSS tokens, the shared overflow menu, and the spinner every screen reuses.
- [Content Security Policy](content-security-policy.md) — the policy the app shell ships with.
- [Docker smoke test](docker-smoke-test.md) — build and verify mouaif in containers.
- [Documentation site](docs-site.md) — how this site is built and published, and the landing screenshots.

## Related

- [App abilities](app-abilities.md) — the same feature set as a guided tour, if you would rather read prose than a list.
- [Documentation site](docs-site.md) — how the pages linked above are built and published.
