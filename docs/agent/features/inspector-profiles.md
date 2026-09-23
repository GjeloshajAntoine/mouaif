# Inspector Chrome profiles — implementation notes

> Agent-facing reference for [`docs/features/inspector-profiles.md`](../../features/inspector-profiles.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### What the feature does not do

mouaif never launches or stops Chrome. The Inspector attaches to a browser you started; this feature only describes the profiles on disk and chooses which endpoint the Inspector uses. Discovery is read-only, so the list still renders when no Chrome is running.

### How profiles are found

[src/inspectorProfiles.js](../../../src/inspectorProfiles.js) does the discovery:

- **Candidate roots** per platform — `LOCALAPPDATA`/`Google/Chrome/User Data` on Windows, `~/Library/Application Support/Google/Chrome` on macOS, `XDG_CONFIG_HOME`-aware `~/.config/google-chrome` on Linux — plus the Chromium, Brave, and Edge equivalents.
- **Profile directories** are `Default` and `Profile N`. Everything else in a user-data-dir (`ShaderCache`, `Crashpad`, `Extensions`) is shared state, not a profile.
- **Names** come from Chrome's own metadata: `Local State` → `profile.info_cache[<dir>].name` first, then `local_profile_name`, then `Preferences` → `profile.name`, and finally the directory name.
- **Directories on disk are the floor.** The info cache can be stale; a profile directory that exists is always listed even when the cache does not mention it.
- A malformed `Local State` degrades to "no metadata" rather than throwing, because Chrome may be caught mid-write.
- **A user-data-dir with zero profiles is a normal state.** A Chrome that was started once and never asked to create a profile leaves a `Local State` with no `info_cache` and no `Default/` directory. The response therefore carries `addedDirs` — the dirs the user registered themselves — as a separate field, so the UI never has to infer "did the user add this?" from "does it have profiles?". Inferring it that way mislabelled such a directory as user-added and gave it a **Remove** button that could not do anything.

`id` is the *directory* name (`Default`, `Profile 1`), not the GUID Chrome keeps internally: the directory name is what the user recognises and what a command line names (`--profile-directory="Profile 1"`). The storage key is `<user-data-dir>::<id>`, so two user-data-dirs may each have a `Default` without colliding.

### Endpoint resolution and switching

Per-profile endpoints and the active id live in the app SQLite store under the `inspectorProfiles` key:

```json
{
  "activeId": "Profile 1",
  "activeLabel": "Personal",
  "endpoints": { "/home/me/.config/google-chrome::Default": "http://127.0.0.1:9223" },
  "dirs": ["/tmp/chrome-portable"]
}
```

An endpoint resolves in this order: the profile's own saved override, then the current global debugger URL. Switching a profile writes that profile's endpoint into the existing global debugger URL via `inspector.setDebuggerUrl()` — which is why no other Inspector module needed to learn about profiles.

Removing an added folder also drops the endpoint overrides for profiles that lived in it, and clears the active marker if the active profile was one of them. Leaving those behind would let the same directory name in another user-data-dir inherit a stale port.

### REST surface

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/inspector/profiles` | — | `{ activeId, globalUrl, defaultUrl, dirs, addedDirs, profiles }` |
| `POST` | `/api/inspector/profiles/switch` | `{ id }` | `{ url, profile: { id, key, label } }` |
| `POST` | `/api/inspector/profiles/endpoint` | `{ id, url }` | `{ url, profile }` |
| `POST` | `/api/inspector/profiles/dirs` | `{ dir }` | `{ dir, profiles }` |
| `DELETE` | `/api/inspector/profiles/dirs` | `?dir=<abs path>` | `{ dir, removed, endpoints }` |

`GET /api/inspector/config` gained `activeProfile` (`{ id, label }` or `null`), read straight from the store so the setup screen can name the active profile with no discovery pass.

Error codes map onto the existing Inspector status helper: `EBADINPUT` / `EBADURL` → `400`, `EPROFILE_NOT_FOUND` / `ENOTPROFILEDIR` → `404`.

### UI

[frontend/src/components/inspector/InspectorProfilesSheet.jsx](../../../frontend/src/components/inspector/InspectorProfilesSheet.jsx) renders the sheet, styled by [frontend/src/inspector-profiles.css](../../../frontend/src/inspector-profiles.css) — the thirteenth part of the Inspector cascade.

Mobile-first constraints it holds to:

- every profile row **is** one button, so the whole ≥ 44 px row is the tap target rather than only its text;
- the secondary actions (**Endpoint**, **Use URL**) sit on their own row under the main button, so attaching can never be hit by accident while aiming for them;
- the per-row endpoint form renders inside the card it belongs to, so the field is never ambiguous about which profile it edits;
- long profile names and user-data-dir paths wrap (or ellipsize) instead of pushing controls off-screen;
- the sheet reuses the shared `.inspector__overlay` / `.inspector__sheet` primitive and the `useModal` hook (Escape, Tab cycle, focus restore).

### Tests

`node scripts/test-inspector-profiles.js` — 116 assertions covering the module (per-platform candidate roots, directory sniffing, name precedence, stale-cache directories, malformed `Local State`, endpoint precedence, switch/set-endpoint/add-dir/remove-dir, and every rejection path) and the HTTP surface on a real ephemeral server (status codes, error mapping, the `activeProfile` round trip, and that a manual URL clears the active marker).

`scripts/test-inspector-feature-inventory.js` gained 14 assertions that freeze this feature's inventory: the entry point, the sheet, the four routes, the 44 px tap minimum, and that discovery never writes to the filesystem.
