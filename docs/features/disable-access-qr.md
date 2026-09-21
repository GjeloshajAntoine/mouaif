# Disable access with a QR code

## Overview

App access protection can be turned off from inside the app. **Settings → Access & passkeys** mints a single-use code and a QR code; opening that QR on any device — signed in or not — loads a confirmation page, and confirming removes the password and passkey wall from the server. Protection can be turned back on from the same screen, with the account password.

## Usage

### Create the disable code and QR

1. Open **Settings → Access & passkeys** while signed in.
2. Tap **Create disable QR & code**. A short code such as `ABCD-2345`, a scannable QR code, and its expiry time appear.
3. Scan the QR with a phone's camera, or open the confirmation page on the device you are already holding.

The code is single-use and expires after 15 minutes. Nothing is generated until you ask for it, and cancelling clears it.

### Confirm on the confirmation page

Scanning the QR opens:

```text
/#/disable-access?code=ABCD-2345
```

The page asks for the confirmation code (pre-filled when the QR was scanned) and warns what turning access off means. Confirming calls `POST /api/access/disable` and immediately clears the login wall for the whole server — no restart is required.

That page works on a device with no session. The one-time code is the proof, which is what makes it usable when the server's password has been forgotten.

### Turn protection back on

While access is off, **Settings → Access & passkeys** shows a **Protection off** badge and a **Turn access back on** button. The device that disabled access keeps its session, so one tap is enough. If the session is gone, any of these re-arms the wall through `POST /api/access/enable`:

- an active session cookie;
- the account username and password;
- a CLI setup code from `mouaif serve --auth-setup`.

### Alerts

Disabling and re-enabling are security-relevant events, so each broadcasts a push notification to every subscribed device ("App access is off…" / "Password and passkey protection is on again."). They use the same **Access alerts** switch as sign-in notifications, which appears both on this screen and as **Sign-in alerts** under Settings → Notifications.

## Implementation notes

- **The persisted switch** is `access_state` (one row) in `src/access-auth.js`: `disabled()`, `setEnabled()`, `effectiveEnabled(processEnabled)`. It is a table rather than a per-process flag because turning a protection off usually means "right now, on this device", and a later restart that still passes `--auth` should not silently re-arm a store whose password may be forgotten.
- **The code and its QR** are modelled on the setup invitation: `createDisableCode()`, `disableCodeValid()`, `consumeDisableCode()` with the `access_disable_codes` table, and `GET /api/access/disable/qr` rendering the confirmation URL with `src/qr.js`. Unlike a setup code it is never printed to stdout and is never served to an unauthenticated caller — it is minted only behind a session.
- **Live re-arming.** `serverConfig.authEnabled` still records the process flag, but `publicAccessStatus()` and `authorizeAccessRequest()` layer `accessAuth.disabled()` on top, so a toggle takes effect within the running worker. `effectiveEnabled()` exists for callers that only have the flag.
- **Recovery.** `POST /api/access/enable` accepts a session, the account password, or a setup code; disabling deliberately does *not* revoke sessions, so the device that turned protection off can turn it back on.
- **Guessing a code is throttled.** `POST /api/access/disable` is reachable without a session, so an invalid or already-used code records a failure against the same per-address counter as a wrong password (ten failures per minute) and answers `429`. A successful disable clears the counter. A setup or disable code carries eight characters from a 32-symbol alphabet (~2⁴⁰), but the limit keeps the endpoint from being a free oracle.
- **Tests.** `scripts/test-access-disable.js` covers the code lifecycle, the no-session confirmation path, live re-arming, the alert broadcast, and re-enabling with a password.

## Related

- [Access authentication](./access-authentication.md) — the account, password, and passkeys this switch protects.
- [Login notification](./login-notification.md) — the alert channel the access on/off notifications share.
- [Push notifications](./push-notifications.md) — how alerts reach the device.
