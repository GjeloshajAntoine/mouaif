# GitHub Copilot

## Overview

Chat with the models in your GitHub Copilot plan (GPT, Claude, Gemini) through mouaif. You sign in once with a GitHub one-time code. mouaif then swaps that sign-in for a short-lived Copilot token on each chat, so no API key is involved.

## Usage

1. Open **Settings → Providers → + Add provider** and choose **GitHub Copilot**.
2. Tap **Sign in with GitHub code**. A code like `ABCD-1234` appears; tap it to copy.
3. Tap **Open github.com/login/device**, paste the code, and approve. Any device works, including another phone or computer.
4. Come back to mouaif. The form shows `signed in as <login>`. Tap **Save**.
5. Add a model to a project with provider `github-copilot`, or pick one from the live list in the chat's model picker.

With several GitHub accounts signed in, pick one in **OAuth account** before saving.

### Advanced: your own OAuth app

The shipped public client works for most accounts. To use your own GitHub OAuth app instead, open **Advanced: custom GitHub OAuth app**, paste its client ID, and tap **Save client ID**.

- The device code sign-in needs **Device Flow** turned on for that app.
- **Sign in with browser redirect** uses the web flow instead. Register the callback URL shown in the form in the app's settings.

## Behavior

- The GitHub token is stored in the OS keychain. The Copilot token lasts about 30 minutes, is kept only in memory, and is renewed automatically.
- Business and Enterprise seats are routed to the API host GitHub assigns to the account. Only `https://*.githubcopilot.com` hosts are accepted.
- The model list comes from your account's live Copilot catalog, so models disabled by your plan or organization policy are not offered. With no sign-in, or if that request fails, a built-in list is shown.
- Tool calls, thinking levels, and max output tokens work as they do for other OpenAI-shaped providers.
- `ENOCOPILOT` means the account has no active Copilot plan. `ESSO_REQUIRED` means the organization requires SAML SSO; the error includes the authorization link.
- An unused code expires after about 15 minutes. Start sign-in again to get a new one.

## API

```text
POST   /api/auth/device/github-copilot          -> { id, userCode, verificationUri, expiresAt, status }
GET    /api/auth/device/github-copilot?id=<id>  -> same shape; status: pending | ok | expired | denied | error | cancelled
DELETE /api/auth/device/github-copilot?id=<id>  -> { ok }
POST   /api/auth/sign-in/github-copilot         -> { authorizeUrl, ... }   (browser-redirect flow)
```

The server polls GitHub itself. The device code never reaches the browser.

## Related

- [AI providers](providers.md) — connecting providers and where credentials are kept.
- [Model picker](model-picker.md) — the live catalog.
