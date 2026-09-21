# mouaif documentation
Use these guides to install mouaif, connect accounts, secure access, and learn what the app can do.
## User guide
- [Getting started](features/getting-started.md) — install with `npx`, `npm install -g`, or a repo checkout; run, update, and complete first setup.
- [CLI commands](features/cli-commands.md) — every `mouaif` command and `serve` option, what the published tarball contains, and why no install needs `npm run build:web`.
- [CLI modal](features/cli-modal.md) — the in-chat command prompt runs on a pseudo-terminal, so a program that asks a question (`npm publish` under 2FA, `git`, `sudo`) can read the answer you type.
- [Authentication](features/authentication.md) — connect AI providers and protect app access, with CLI examples.
- [App abilities](features/app-abilities.md) — projects, chats, coding tools, agents, MCP, and Inspector.
- [Chat backward pagination](features/chat-backward-pagination.md) — long chats load the newest page immediately, then eagerly load all older history in the background.
- [Chat transcript rendering](features/chat-transcript-rendering.md) — unchanged transcript rows and header cards are reused instead of rebuilt, so the conversation area no longer flashes.
- [Tool card expanded view](features/tool-card-expanded-view.md) — what an expanded tool card shows, including a long command in full above its output.
- [Draft Craft](features/draft-craft.md) — add selected code or annotated Inspector images to any chat draft.
- [Add Inspector entries to a chat](features/inspector-add-to-chat.md) — send a console log, exception, or network request to a chat draft from the detail sheet.
- [Inspector Styles](features/inspector-styles.md) — tap to select an element and edit its CSS in the Inspector.
- [Inspector touch controls](features/inspector-touch-controls.md) — change the selected element's CSS with chips, sliders, a box model and swatches.
- [Inspector full screen](features/inspector-fullscreen.md) — expand one Inspector panel over the whole viewport from its card header.
- [Inspector JavaScript console](features/inspector-js-console.md) — the editable console under the log, sized for a phone's soft keyboard: Enter inserts, `Ctrl`+Enter runs.
- [Inspector Chrome profiles](features/inspector-profiles.md) — switch which Chrome user profile the Inspector attaches to (entry point currently hidden).
- [Inspector target-origin model](features/inspector-target-origin.md) — which element, which rule and where an edit lands, as read inside the Styles panel.
- [Inspector value types](features/inspector-value-types.md) — switch a value between length, number, percentage and keyword, with the cost stated.
- [Inspector value suggestions](features/inspector-value-suggestions.md) — the values and design tokens this page already uses, with the evidence.
- [Inspector value rail](features/inspector-value-rail.md) — one numeric changer for every value kind, with the page's own values as its ticks.
- [Inspector intent](features/inspector-intent.md) — describe a change in words and review a cited diff, one ticked line at a time.
- [Inspector non-destructive editing](features/inspector-non-destructive-editing.md) — what an edit changes, what it keeps, and how to undo it.
- [Restart from chat](features/chat-app-restart.md) — gracefully relaunch the app worker by asking the assistant.
- [MCP server error modal](features/mcp-error-modal.md) — inspect complete server startup failures in Settings.
- [MCP OAuth sign-in](features/mcp-oauth.md) — connect HTTP MCP servers with PKCE, keychain-backed tokens, and refresh.
- [Custom actions](features/custom-actions.md) — run project CLI commands or MCP tools from `@` mentions and the Tools popup.
- [Web preview page](features/webpreview-project-page.md) — capture and view a web URL from project settings.
- [Hide file content](features/hide-file-content.md) — mark line ranges or selected text the agent file tools must not reveal.
- [Project search engine](features/search-engine.md) — `search_files` runs on ripgrep when a binary is available and on a bounded JS walk when not; same results, same redaction, ~400× faster.
- [Opening images with `read_file`](features/read-file-images.md) — the agent opens a picture, sees it, and the chat card shows what the model received.
- [Docker smoke test](features/docker-smoke-test.md) — build and verify mouaif in containers with a mounted example project.
- [Retry and auto-retry](features/retry-and-auto-retry.md) — retry failed turns from their error card, or let the app retry once automatically.
- [Message copy](features/message-copy.md) — a tap-sized copy icon under every user and assistant bubble, with in-place feedback.
- [Subagent transcript](features/subagent-transcript.md) — the delegated conversation inside an expanded subagent card renders as chat rows, and the card names the agent it dispatched.
- [Responsive layout](features/responsive-layout.md) — the app frame grows with the window instead of staying a 480 px phone column.
- [Content Security Policy](features/content-security-policy.md) — the policy the app shell ships with, directive by directive.
- [Routing](features/routing.md) — every hash the app answers, its query parameters, and the old names that still work.
- [Modal sheets](features/modal-sheets.md) — Escape, Tab and focus behave the same in every full-screen sheet, including stacked ones.
- [Dictation](features/dictation.md) — speech-to-text from a page under Settings (App defaults) and from the chat composer, which transcribes while you speak; with a chosen model, three request families (multipart, inline-audio chat, Gemini), a per-run cost, and a chat take that joins that chat's Total.
- [File button: glass orb](features/file-button-orb.md) — render the composer's file/git button as an animated 3D glass orb, from Settings → Chat defaults.
- [Composer tool buttons](features/composer-tool-buttons.md) — hide the composer's dictation microphone or image button from Settings → Chat defaults; hiding a button removes a way to reach a capability, never the capability.
- [Ask the user tool](features/ask-user-tool.md) — the model pauses the chat to ask a structured question with options, presets and a free-form extra answer; one card per question, and the answer is folded back as a `tool` message.
- [Login notification](features/login-notification.md) — browser alert on a new sign-in, broadcast to every subscribed device.

## Build the documentation

```bash
npm run docs:build            # public site -> docs-dist/
npm run docs:build:internal   # + maintainer pages (decisions, agent notes)
```

- [Documentation site](features/docs-site.md) — what is published, what stays maintainer-only, how GitHub Pages deploys it, and the landing page's six-capture screenshot row (`npm run docs:shots`).

The generated public navigation links only to the published guides (Getting started, Authentication, App abilities, Draft Craft). Maintainer references — `docs/decisions.md` and `docs/agent/features/*.md` — remain in the repository for contributors, are written into the site only by `npm run docs:build:internal`, and are never shown or linked on the published site.
