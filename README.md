# mouaif 🚀

**Mobile Ouaib first.** mouaif is a mobile-first AI coding assistant for local projects. It runs as a small server on your computer; you open it in a browser — on the same computer or on your phone — connect the AI providers you choose, chat about a project, and decide which coding tools the assistant may use.

## Quick start

You need **Node.js 20 or newer** (`node --version`) and an AI provider: an API key, a browser sign-in (Anthropic, OpenRouter, GitHub Copilot), or a local model with Ollama, llama.cpp, or LM Studio.

```bash
npx mouaif serve --auth
```

1. **Create your login.** Open the setup link printed in the terminal (or scan its QR code) and choose a username and password. Keep the terminal open — `Ctrl+C` stops mouaif.
2. **Connect a provider.** In the app, open **Settings → Providers**, tap **+**, and enter a key or tap **Sign in**.
3. **Add a project.** On the **Chats** tab, tap **+** and pick a folder.
4. **Chat.** Tap **New chat** on the project card, pick a model in the header, and send a message.

The full walkthrough, with troubleshooting, is in [Getting started](docs/features/getting-started.md).

## Install

| Method | Command |
|---|---|
| Run without installing | `npx mouaif serve --auth` |
| Global command | `npm install -g mouaif` then `mouaif serve --auth` |
| From source | `git clone https://github.com/GjeloshajAntoine/mouaif.git && cd mouaif && npm install && npm link` |

The npm package is [`mouaif`](https://www.npmjs.com/package/mouaif) and ships a pre-built web UI, so there is no build step. In a source checkout, `npm install` builds the UI for you.

## CLI at a glance

```bash
mouaif serve --auth                     # start, login required (recommended)
mouaif serve --auth --host 0.0.0.0      # reach it from a phone on your Wi-Fi
mouaif serve --auth --port 9000         # use another port (default 5732)
mouaif serve --auth-setup               # print a new setup link / QR code
MOUAIF_PASSWORD='a-long-password' \
  mouaif serve --auth --user alice      # set the login from a script
mouaif info                             # version and default port
mouaif --help                           # all commands
```

Every option and environment variable: [CLI commands](docs/features/cli-commands.md). App login and passkeys: [Authentication](docs/features/authentication.md). Provider keys: [AI providers](docs/features/providers.md).

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

- [Getting started](docs/features/getting-started.md) — step-by-step install, first setup, phone access, update, and troubleshooting.
- [CLI commands](docs/features/cli-commands.md) — every command, option, and environment variable.
- [Authentication](docs/features/authentication.md) — require a login to open mouaif.
- [AI providers](docs/features/providers.md) — connect the providers mouaif calls.
- [App abilities](docs/features/app-abilities.md) — projects, chats, coding tools, agents, MCP, and Inspector.
- [Draft Craft](docs/features/draft-craft.md) — add selected code or annotated Inspector images to a chat draft.

Build the static documentation site with:

```bash
npm run docs:build
```

## License

MIT — see [LICENSE](LICENSE).
