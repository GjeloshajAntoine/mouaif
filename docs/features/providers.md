# AI providers

## Overview

To send a message, mouaif needs a connection to the provider that serves the model you picked. A connection is an API key — or a browser sign-in — that you give to the provider. It does **not** log you into mouaif; for the app login see [Authentication](./authentication.md).

Connections live at app level, not per project: you add a provider once and every project can use it.

## Usage

### Connect a provider

1. Open **Settings → Providers**.
2. Tap **+ Add provider** and choose a provider from the list.
3. Enter the requested API key and API base URL, or tap **Sign in** when the provider offers browser sign-in.
4. Save the provider, then run its model refresh or connection test to confirm it works.

The built-in providers are:

- **OpenAI compatible** — any OpenAI-shaped endpoint (OpenAI, Together, LM Studio, llama.cpp `llama-server`). The key may be left blank for a local server that needs none, see [Local OpenAI-compatible servers](./local-openai-servers.md).
- **Anthropic** — API key or browser sign-in, see [Anthropic sign-in](./oauth-anthropic.md).
- **Google Gemini** — API key.
- **Ollama** — local server, no API key required.
- **OpenRouter** — one key for many upstream models, or browser sign-in, see [OpenRouter](./openrouter.md).
- **GitHub Copilot** — sign in with a GitHub one-time code, see [GitHub Copilot](./github-copilot.md).
- **Azure OpenAI**, **Mistral**, **Groq**, **DeepSeek** — API key, see [Cloud model providers](./cloud-providers.md).

### Add a model to a project

Open a project's settings, then its **Models** editor, and add an entry that names this provider and the model id you want. The live model catalog in the chat's model picker can also refresh and pull the provider's own list.

### Sign in with an account instead of a key

Anthropic and OpenRouter offer **Sign in** in the provider form: the browser is sent to the provider, you authorize mouaif, and the resulting token or key is stored on your computer. GitHub Copilot uses a one-time code you enter at github.com/login/device instead. You can sign in with more than one account for the same provider and pick the account in the provider form.

## Where credentials are kept

- **API keys** are saved in the app's own settings store on the computer that runs mouaif (`~/.mouaif/store.sqlite`), never in a project folder. The web UI only learns whether a key is set; it never receives the key itself.
- **Browser sign-in tokens** are saved in the operating system's keychain.
- Credentials never leave that computer except in requests to the provider they belong to.
- **Delete** in the provider form removes a connection. Project models that use it stop working until you add it again.

## Related

- [Authentication](./authentication.md) — require a login to open mouaif.
- [Settings](./settings-ui.md) — the Providers screen.
- [App and project settings](./app-and-project-settings.md) — where provider connections live.
- [AI client](./ai-client.md) — the server-side proxy that talks to providers.
