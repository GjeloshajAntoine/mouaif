# AI providers

## Overview

To send a message, mouaif needs a connection to the provider that serves the model you picked. A connection is an API key — or a browser sign-in — that you give to the provider. It does **not** log you into mouaif; for the app login see [Authentication](./authentication.md).

Connections live at app level, not per project: you add a provider once and every project can use it.

## Usage

### Connect a provider

1. Open **Settings → Providers** and tap **+ Add provider**.
2. Choose how you want to connect:
   - **Sign in with an account** — Claude Pro or Max, ChatGPT (Codex), GitHub Copilot, or OpenRouter.
   - **Paste an API key** — OpenAI, Anthropic, Google Gemini, OpenRouter, Mistral, Groq, DeepSeek, Azure OpenAI, or another OpenAI-compatible service.
   - **Run on your own server** — Ollama, LM Studio, or llama.cpp.
3. Fill in what the next screen asks for. A name and a custom address are under **Advanced** when you don't need them.
4. Tap **Add provider**. If you signed in, the provider is added as soon as sign-in finishes.

mouaif then tests the connection. If it works, you return to the list. If it doesn't, the provider is still saved and you land on its form with the reason, so you can fix it or delete it.

### Connection status

The provider list shows how each connection is doing:

| Status | What it means |
|--------|---------------|
| **Connected · 42 models** | The provider answered and listed its models. |
| **Saved · can't be tested** | mouaif can't test this provider without sending a message: Anthropic, OpenRouter and GitHub Copilot list their models whatever the key or sign-in. Send a message to confirm it works. |
| **Needs an API key** / **Needs sign-in** | The connection has no credential, and this provider requires one. |
| **API key rejected** / **Sign-in rejected** | The provider refused the credential. |
| **Can't reach the server** / **No answer from the server** | Nothing answered at this address. For a local server, check that it's running. |
| **Nothing found at this address** | A server answered, but not with a model list. Check the address. |

Open a connection and tap **Test saved settings** to test it again. It tests what is saved, not changes you haven't saved yet.

The built-in providers are:

- **OpenAI compatible** — any OpenAI-shaped endpoint. You add it as **OpenAI**, **LM Studio**, **llama.cpp**, or **Another OpenAI-compatible service**. Only OpenAI itself requires a key, see [Local OpenAI-compatible servers](./local-openai-servers.md).
- **Anthropic** — API key or browser sign-in, see [Anthropic sign-in](./oauth-anthropic.md).
- **Google Gemini** — API key. The connection's base URL drives both chat and the model catalog (a proxy, gateway, or regional host works), and OAuth accounts for Gemini are indexed under the `google` namespace the server uses.
- **OpenAI Codex** — use your ChatGPT plan with device-code sign-in, see [OpenAI Codex](./codex.md).
- **Ollama** — local server, no API key required. The connection's base URL is used for both chat and its model catalog, so a server on another host (or a non-default port) lists *its* models.
- **OpenRouter** — one key for many upstream models, or browser sign-in, see [OpenRouter](./openrouter.md).
- **GitHub Copilot** — sign in with a GitHub one-time code, see [GitHub Copilot](./github-copilot.md).
- **Azure OpenAI**, **Mistral**, **Groq**, **DeepSeek** — API key, see [Cloud model providers](./cloud-providers.md).

### Connect the same provider more than once

Tap **+ Add provider** again and make the same choice. Each connection keeps its own API key or signed-in account, base URL, model list and balance, so you can use a work and a personal account side by side, or an LM Studio server next to a llama.cpp one.

Give each connection a **Name**, under **Advanced**, so you can tell them apart. The name appears in Settings and in the model pickers, and you can change it at any time. Without a name, pickers show the connection's id. OpenAI, LM Studio and llama.cpp name themselves if you leave it empty.

The first connection of a provider has the provider's own id, such as `openai-compatible`. Later ones get `openai-compatible-2`, `openai-compatible-3` and so on. An id never changes, and you can't change a connection's provider after adding it.

### Add a model to a project

Open a project's settings, then its **Models** editor, and add an entry that names this provider and the model id you want. Use the connection's id as the provider. The live model catalog in the chat's model picker can also refresh and pull the provider's own list.

### Sign in with an account instead of a key

Claude Pro or Max and OpenRouter send the browser to the provider, you authorize mouaif, and the resulting token or key is stored on your computer. GitHub Copilot and ChatGPT (Codex) use a one-time code instead. Finishing sign-in adds the provider. If you've already signed in, choose the account and tap **Add provider**, or tap **Sign in with another account**. To use two accounts at once, add a connection for each.

## Where credentials are kept

- **API keys** are saved in the app's own settings store on the computer that runs mouaif (`~/.mouaif/store.sqlite`), never in a project folder. The web UI only learns whether a key is set; it never receives the key itself.
- **Sign-in tokens and MCP OAuth secrets** are saved in a dedicated credential table in the same app SQLite DB, not in settings responses. New sign-ins do not require a keychain.
- The DB is **not encrypted by mouaif**. Protect it and its backups like password files. See [Credential storage](./credential-storage.md).
- Credentials never leave that computer except in requests to the provider they belong to.
- **Delete** in the provider form removes a connection. Project models that use it stop working until you add it again.

## Related

- [Authentication](./authentication.md) — require a login to open mouaif.
- [Settings](./settings-ui.md) — the Providers screen.
- [App and project settings](./app-and-project-settings.md) — where provider connections live.
- [AI client](./ai-client.md) — the server-side proxy that talks to providers.
