# mouaif 🚀

mouaif is a mobile-first AI coding assistant for local projects. Connect your preferred AI providers, chat about a project, and choose which coding tools the assistant may use.

## Requirements

- Node.js 18 or newer
- A supported AI provider account, or a local Ollama installation

## Install

The npm package is named [`mouaif`](https://www.npmjs.com/package/mouaif), and it exposes the `mouaif` command. Run it once through `npx` without installing anything globally:

```bash
npx mouaif serve
```

Install the `mouaif` command globally:

```bash
npm install -g mouaif
```

Or install from a checkout of this repository:

```bash
git clone <repo-url>
cd mouaif
npm install
npm link
```
`npm install` builds the web UI once when its sources are newer than `frontend/dist/` (the Vite toolchain is present in a source checkout), so there is no separate build step. `npm link` makes the `mouaif` command available in your terminal.

Every install ships the pre-built web UI in `frontend/dist/`, so `mouaif serve` never builds the frontend. The package depends on `better-sqlite3` and `@napi-rs/keyring`, which ship prebuilt binaries for common platforms; on an unusual platform Node compiles them, so the first install can take a few minutes.

## Run

```bash
mouaif serve
```

Open `http://127.0.0.1:5732/` in a browser. Keep the terminal open while using mouaif and press `Ctrl+C` to stop it.

Useful commands:

```bash
mouaif serve --port 9000     # use another port
mouaif serve --host 0.0.0.0 # listen on your local network
mouaif info                  # show version and default port
```

## First setup

1. Open the **Chats** tab and tap **Add project**.
2. Choose an existing folder or create one.
3. Open **Settings → Providers** and connect an AI provider.
4. Open the project settings and add or select a model.
5. Create a chat and send your first message.

## Authentication

### Connect an AI provider

Open **Settings → Providers**, select a provider, then enter its API key or use **Sign in** when offered. Supported connections include OpenAI-compatible services, Anthropic, Google Gemini, Ollama, OpenRouter, GitHub Copilot, Azure OpenAI, Mistral, Groq, and DeepSeek.

### Protect access to mouaif

Access authentication is optional. With no global install, use the npm package name with `npx` to generate an expiring setup link, QR code, and short code:

```bash
npx mouaif serve --auth-setup
```

Set credentials while keeping the password out of shell history:

```bash
MOUAIF_PASSWORD='a-long-password' \
  npx mouaif serve --auth --user alice
```

PowerShell:

```powershell
$env:MOUAIF_PASSWORD = 'a-long-password'
npx mouaif serve --auth --user alice
```

After setup, require login on future starts with:

```bash
npx mouaif serve --auth
```

If you installed `mouaif` globally, the shorter equivalent is `mouaif serve --auth`; the auth options are identical. Use HTTPS and `--public-origin` before making mouaif available outside the computer running it.

## App abilities

- Organize chats by local project and select models per chat.
- Attach files and images, use custom prompts, and control reasoning options.
- Use **Draft Craft** to send selected code or an annotated Inspector image to any chat draft.
- Let the assistant read and edit project files.
- Run approved non-interactive shell commands and view live output.
- Track tasks, answer structured questions, and delegate work to project agents.
- Connect additional tools through MCP.
- Preview pages and inspect console and network activity in the Inspector.
- Gate tools per project with **Off**, **Ask**, or **Allow**.
- Export chat traces and receive browser notifications for long-running work.

## Documentation

- [Getting started](docs/features/getting-started.md) — install, run, update, and first setup.
- [Authentication](docs/features/authentication.md) — connect AI providers and protect app access.
- [App abilities](docs/features/app-abilities.md) — projects, chats, coding tools, agents, MCP, and Inspector.
- [Draft Craft](docs/features/draft-craft.md) — add selected code or annotated Inspector images to a chat draft.

Build the static documentation site with:

```bash
npm run docs:build
```

## License

MIT
