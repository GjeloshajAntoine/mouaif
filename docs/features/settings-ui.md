# Settings — REST surface and mobile UI

## Overview

Two surfaces in this commit. The REST surface is the endpoints the mobile UI calls; the mobile UI is the panel at `/` that lets a user edit app-level settings, provider connections, and raw project settings without `curl`.

The endpoints build on [docs/features/app-and-project-settings.md](./app-and-project-settings.md) and [docs/decisions.md §1–§3](../decisions.md). The current UI manages app-level provider connections and project settings.

Project settings use a simple mobile-first list. Technical details (the raw `.mouaif.json` editor and resolved values) are on a dedicated page linked at the very bottom. Every agent row also opens a dedicated configuration page for its instructions, model, tools, and deletion action.

## Usage

### Mobile UI

The mobile UI exposes a **Settings** destination in the bottom tab bar at `/`. The screen is a stack of focused sub-views, each with its own back link; the bottom tab bar is hidden on the sub-views so the content owns the full viewport height. Project settings carries an explicit `from` route when opened from either project list, so Back returns to that list; chat links carry `chatId` and return to the chat, while direct links safely fall back to Settings home. The `from` origin is threaded through the Agents list and agent editor too, so Back from an agent returns to the project-settings page that opened it, and then onward to the originating project list.

The home screen groups cards by scope so app-level and project-level settings never sit in the same list. Rather than repeat "overrides / wins / shadows" on every row, the layering is stated plainly and once: the **App defaults** group title notes it applies to every project, the **This project** footer says a project can change any default for its own folder, and the project page has a "Inherit app default" option where it matters. The mental model is two layers — *app defaults apply everywhere; a project can change them for its own folder* — not a chain of winners and losers.

- **Providers** — `Providers` (account-level connections you sign into / add keys for; not part of the app/project layering).
- **App defaults** (title note: *Apply to every project*) — cards: `Chat defaults` (`prompt style`), `Dictation` (`speech-to-text model & transcript`), `MCP servers` (`servers & default permission`), `About & reset` (`storage · danger zone`). (The GitHub Copilot OAuth-app `client_id` is **not** a separate card here — it lives inside the Copilot provider form, next to that provider's sign-in, so all Copilot auth is in one place.)
- **This project** — only rendered when a project is active (set by opening a chat, the project picker, or loading a project here). The group title shows the active project's name/path so the scope is concrete, not abstract. Cards: `Project settings` (`prompt style, tools, agents`), `MCP servers` (`app servers + this project's own`), `Custom prompts`, each linking with `?projectDir=<active>` so the destination view auto-loads without a manual paste. When no project is active the group shows a one-line hint pointing the user at a chat / the picker instead of dead links.

Each card's summary line reflects live state (e.g. `1 connected`, `3 models priced`) with a static fallback so the list never flashes a bare `—` before load resolves.

| Hash route | View | Purpose |
|------------|------|---------|
| `#/settings` | `SettingsHomeView` | Scope-grouped card list (see above). |
| `#/settings/providers` | `SettingsProvidersView` | List of configured providers + an `+ Add provider` entry. |
| `#/settings/providers/new` | `SettingsProviderEditView` | New provider form. |
| `#/settings/providers/<id>` | `SettingsProviderEditView` | Edit / delete an existing provider. |
| `#/settings/defaults` | `SettingsDefaultsView` | `Default prompt style` (select) + `Enter inserts a newline instead of sending` (switch). Save writes to `PUT /api/settings/app`. |
**Composer keyboard default.** The Chat defaults view adds an app-level switch, `enterForNewline` (default on). When on, Enter inserts a newline in the composer and you send with the send button or Ctrl/Cmd+Enter; when off, Enter sends and Shift+Enter inserts a newline. The value is read at chat-load time from app settings and drives the textarea `onComposerKey` handler, so it applies to every chat unless overridden elsewhere. |
| `#/settings/project[?projectDir=<abs path>][&chatId=<id>][&from=projects\|settings/projects]` | `SettingsProjectView` | Per-project overrides (prompt style, tool authorization, agent files, agents) + a "This chat" group for the chat the user came from (`?chatId=…`). `from` preserves which project list opened the page so Back returns there. The `from` origin survives a round-trip through any sub-page (File tool options, Web preview, Technical details) and the sibling project-scoped views (Custom prompts, Agents, MCP servers, Custom actions), so the project page and all of them re-emit `&from=<origin>` on their own back links and onward links — returning to the project page after exploring keeps "Back to projects / project list" instead of degrading to "Back to settings". Agent files default to on unless the project explicitly sets `agentFiles: false`; chat-level toggles can opt out, but cannot bypass that project lock. Raw `<projectDir>/.mouaif.json` editor and resolved view live in a collapsed Advanced section. Seeds the directory from `?projectDir=` or the active project and auto-loads. |
| `#/settings/project/technical[?projectDir=<abs path>][&chatId=<id>][&from=<origin>]` | `SettingsProjectView` (`page: 'technical'`) | **Technical details** — raw `.mouaif.json` editor, resolved settings, and (when `chatId` is present) the current chat's trace toggle, trace export, and delete-chat actions. `from` is re-emitted on the back link so returning to the project page keeps the originating list. |
| `#/settings/project/output[?projectDir=<abs path>][&from=<origin>]` | `SettingsProjectView` (`page: 'output'`) | **File tool options** — the `toolOutput` profile (one three-option preset select: Small / Balanced / Full) with a live JSON readout, a sibling of Technical details under Settings → Project. `from` is re-emitted on the back link. |
| `#/settings/project/preview[?projectDir=<abs path>][&from=<origin>]` | `SettingsProjectView` (`page: 'preview'`) | **Web preview** — capture a URL in the Inspector debug Chrome and view it full screen, the same surface the chat `webpreview` tool uses. `from` is re-emitted on the back link. |
| `#/settings/copilot` | — (legacy alias) | Old GitHub Copilot OAuth screen. The `client_id` field now lives in the Copilot provider form; this hash redirects to `#/settings/providers/github-copilot`. |
| `#/settings/tags[?projectDir=<abs path>]` | `SettingsTagsView` | Per-project file tagging (decisions §15). Resolves the registered project id from `projectDir` when no `projectId` is passed. |
| `#/settings/access` | `AccessSettingsView` | Manage access authentication, change password, enroll/remove WebAuthn passkeys, and sign out. |
| `#/settings/about` | `SettingsAboutView` | Storage location, in-code defaults, and the destructive "Reset all app settings" action. |

The provider form has all fields on one screen: provider id (locked after creation), API base URL, authentication mode, an API key (when the auth is `apikey`) or an OAuth-account <select> with an inline sign-in helper (when the auth is `oauth`). On the **new**-provider screen the provider `<select>` defaults to `openai-compatible` (the first, API-key-only entry). The active option is marked with the `selected` attribute rather than a controlled `value` prop on the `<select>`; a controlled `value` set before the `<option>` children are attached is silently dropped by the DOM, which made the picker fall through to the *last* entry (`github-copilot`) and open the new-provider form on the OAuth-only screen for no reason. The reserved `github-copilot` provider hides the API base URL row (the base URL is hard-coded) and replaces the auth `<select>` with a static "OAuth (required)" badge. The provider's `hint` is also promoted to a colored notice so the OAuth requirement is unmistakable on a phone. The same reserved-rail hides the `apikey` row and forces `auth: oauth` at save time, so a user cannot submit a model the server would later reject with `ENOAUTH`.

**GitHub Copilot OAuth-app `client_id`.** GitHub will not let a third-party app use the public Copilot `client_id` with a loopback callback, so the Copilot sign-in needs a per-install OAuth-app `client_id` (stored in app settings under `githubCopilot.clientId`; blank = shipped default). That field is rendered **inside the Copilot provider form** — only when the provider is `github-copilot` and the auth is OAuth — right above the Sign in button, with its own "Save client ID" action (decoupled from the provider Save so you can set the id, sign in, then save the record). It used to be a standalone `Application` card (`#/settings/copilot`); that screen was removed and the route is now a redirect. This keeps everything Copilot-auth (client id → sign in → account) on one screen instead of split across two settings sections.

**OAuth is only offered for providers the server can actually sign into.** Each entry in `SETTINGS_PROVIDERS` carries an `oauth: true` flag when the server has an OAuth flow registered for it (the `oauth*.register()` calls in `src/server-shared.js`); `reserved` implies OAuth-only. Currently that is **Anthropic** (key *or* OAuth), **OpenRouter** (key *or* OAuth via PKCE) and **GitHub Copilot** (OAuth-only). For every other provider (OpenAI-compatible, Gemini, Ollama) the authentication `<select>` is hidden entirely — there is a single mode (API key), so a one-option picker would be noise — and the "Sign in" button is never shown. This closes a real bug: the form used to offer OAuth for every provider, and picking it then tapping "Sign in" hit `POST /api/auth/sign-in/<id>`, which returns **404** for providers with no OAuth flow. `startSignIn()` also guards against this directly, showing "does not support OAuth sign-in; use an API key." instead of the raw 404. (Regression watch: if a provider's exchange is not registered — e.g. the `oauth*.register()` calls at server startup are dropped — the sign-in endpoint returns **501** "not registered in this build" even though the UI offered the OAuth mode.)

The project view loads both the raw project file and the resolved view in parallel. Saving the project refreshes the resolved view in the same tap.

Project settings use a regular, single-column form: a quiet path and scope introduction followed by consistently titled sections (`General`, `Tools`, `Agent files`, `Agents`, and `More settings`). Controls span the available mobile width, descriptions use plain language, and every existing option remains available. Advanced raw JSON stays collapsed at the bottom.

The project view's groups are scoped on purpose: a **Chat defaults** group holds settings that live in `.mouaif.json` and apply to chats in this project (prompt style today; anything left on its default follows the app-level value). Per-chat actions are never mixed into a project group — a per-chat action next to a project setting reads as "this writes `.mouaif.json`", which it does not. The trace toggle, trace export, and delete-chat all live on the **Technical details** page instead. Reach it from the chat's settings button → the **Technical details** link at the bottom of project settings, which carries the `chatId`. The page shows the chat-scoped trace/export/delete controls only when a `chatId` is on the route; without one it shows just the raw `.mouaif.json` editor and the resolved settings.

The UI is mobile-first: stacked rows, minimum 44 px touch targets, system colors, and safe-area awareness.

## Behavior

- **Global provider connections** — editing an existing provider updates its settings globally across all projects.
- **Project overrides** — models and prompt styles customized in project settings apply specifically to that project.
- **Reset app settings** — the "Reset all app settings" button in Settings → About allows resetting global settings to defaults while leaving all on-disk project files untouched.
- **Provider deletion** — removing a provider connection prompts for confirmation.

## Related

- Storage: [docs/features/app-and-project-settings.md](./app-and-project-settings.md).
- Access security: [docs/features/access-authentication.md](./access-authentication.md).
- Chat proxy that consumes the models list: [docs/features/ai-client.md](./ai-client.md).
