# Provider authentication

## Overview

mouaif connects to AI providers using API keys or browser-based OAuth authentication (such as Anthropic and OpenRouter). Credentials are encrypted securely in your operating system's keychain or stored safely in your local app settings, ensuring no secrets are exposed in code repositories or network traffic.

## Connecting providers

1. Navigate to **Settings → Providers**.
2. Select a provider from the list (e.g., Anthropic, OpenRouter, OpenAI-compatible, Google Gemini, Ollama, DeepSeek, Groq, Mistral, Azure OpenAI).
3. Choose your preferred authentication method:
   - **API Key** — enter your API key and tap save.
   - **Sign in / OAuth** — tap the sign-in button to authenticate in your browser. Upon approving permissions, you will be redirected straight back into mouaif.

## Multi-account & Security

- **Secure local storage** — credentials remain local to your machine and are never synchronized or uploaded to third parties.
- **Multiple accounts** — you can sign in to multiple accounts per provider and switch between them when configuring models.
- **Revoking access** — remove any connected provider or sign out of accounts at any time from **Settings → Providers**.

## Related

- [Access authentication](./access-authentication.md) — optional web UI and API access protection via password and WebAuthn passkeys.
- [AI client](./ai-client.md) — supported provider capabilities and options.
- [OpenRouter](./openrouter.md) — connecting with OpenRouter API keys or OAuth.
- [Anthropic OAuth](./oauth-anthropic.md) — signing in with Anthropic.
