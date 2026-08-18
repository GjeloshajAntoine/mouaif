# mouaif 🚀

mouaif is a mobile-first AI coding assistant for local projects. Connect your preferred AI providers, chat about a project, and choose which coding tools the assistant may use.

## Requirements

- Node.js 18 or newer
- A supported AI provider account, or a local Ollama installation

## Install

```bash
git clone <repo-url>
cd mouaif
npm install
npm run build:web
npm link
```

`npm link` makes the `mouaif` command available in your terminal.

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

Access authentication is optional. Generate an expiring setup link, QR code, and short code:

```bash
mouaif serve --auth-setup
```

Set credentials from the CLI while keeping the password out of shell history:

```bash
MOUAIF_PASSWORD='a-long-password' \
  mouaif serve --auth --user alice
```

PowerShell:

```powershell
$env:MOUAIF_PASSWORD = 'a-long-password'
mouaif serve --auth --user alice
```

After setup, require login on future starts with:

```bash
mouaif serve --auth
```

Use HTTPS and `--public-origin` before making mouaif available outside the computer running it.

## App abilities

- Organize chats by local project and select models per chat.
- Attach files and images, use custom prompts, and control reasoning options.
- Let the assistant read and edit project files.
- Run approved non-interactive shell commands and view live output.
- Track tasks, answer structured questions, and delegate work to project agents.
- Connect additional tools through MCP.
- Preview pages and inspect console and network activity in the Inspector.
- Gate tools per project with **Off**, **Ask**, or **Allow**.
- Export chat traces and receive browser notifications for long-running work.

## Documentation

- [Getting started](docs/features/getting-started.md)
- [Authentication](docs/features/authentication.md)
- [App abilities](docs/features/app-abilities.md)

Build the static documentation site with:

```bash
npm run docs:build
```

## License

MIT
