# Review: system prompts and default-enabled tools

Date: 2026-11-14

The prompt-size layering works as designed, but the custom-prompt "Chat preset" (the default-tools part) is mostly broken. This was found by reading the code and running the preset functions in node; nothing was tested in the browser or the Docker app. The prod store has 1,853 chats, none with a custom prompt attached, so the preset defects are latent rather than biting today.

## How it resolves today

| Thing | App | Project | Chat |
|---|---|---|---|
| Built-in prompt (`promptSize`) | `PUT /api/settings/app` | overrides app | copied onto the chat at creation; editable only while the chat is empty |
| Custom prompt | prompt library | prompt library (wins on same id) | `promptId` plus a pinned `promptSnapshot`; no project-level default prompt exists |
| Tool permission (off/ask/allow) | `tools.<family>` | overrides app, per family or leaf | `chat.toolAuth` wins over both |
| Tool selection (what is advertised) | none | none | `chat.tools` allowlist; unset means everything |
| Agent files / skills | none | master switch (false locks off) | per-chat toggle, then profile default |

The upstream message order is: profile text, agent files, skills catalog, feature summary, tagged files, artifacts, custom prompt, transcript (`src/server-handlers-chats.js:1178-1276`).

The tool list is built as: all specs, minus anything with permission `off`, minus share-gate denials, filtered by `chat.tools`, then reduced for the very-small profile (`src/ai-stream.js:960-1055`).

## Findings

1. **Preset tool selection does nothing on a normal chat.** `effectivePresetConfig` only merges `preset.tools` when the chat already has an allowlist (`src/prompts.js:403`). A new chat has none, and `createChat` does not seed one from the preset. So whatever is ticked in the Chat preset tree, a chat started from that prompt gets every tool.

2. **On a chat that does have an allowlist, the preset re-enables tools the user unchecked.** The union runs every turn in memory. The Tools popup reads the stored `chat.tools`, so it shows a tool as off while the model still receives it. The permission gate still applies; only the selection is overridden.

3. **Saving a tools-only preset silently turns agent files and skills off.** The editor always sends both booleans once anything is set (`frontend/src/components/SettingsPrompts.jsx:493`), and an explicit `false` is kept and applied.
   - `{tools:['shell'], agentFiles:false}` on a chat with `agentFiles:true` resolves to `agentFiles:false`.
   - The chat's own toggle is overridden each turn, and the popup still shows it on.
   - The docs call presets "purely additive"; this is not.

4. **File tools cannot be saved in a preset.** The tree emits leaf ids (`read_file`, `edit_file`, `group_read`, and so on), but `PRESET_TOOL_NAMES` only contains `file` (`src/prompts.js:80`). `normalizePreset(['shell','read_file'])` returns `['shell']`. After a save and reload, every file row should show unchecked.

5. **Some names a preset stores can never match.** The stream filter matches exact spec names. `file` matches nothing, and neither does the `mcp__<slug>__*` wildcard the editor writes for servers with no cached tools (`SettingsPrompts.jsx:641`).

6. **The "default off" rows are cosmetic.** `group_read`, `group_edit` and `group_cli` render unchecked on a fresh preset, but that state saves as "no preset", and `DEFAULT_OFF_TOOLS` in `src/tools/authorization.js:186` is empty. They are still advertised.

7. **The "Chat" built-in is not a plain conversation.** It only empties the profile text. Agent files, the skills catalog, the feature summary and all ~50 tool specs are still sent. The seeded Chat prompt with an empty-tool preset that used to cover this was removed in the 2026-09-26 migration.

8. **The tool preview does not match the stream.** `GET /api/chats/:id/tool-preview` omits the subagent orchestration tools, `task`, `group_cli`, the schedule, webhook and hook tools, and the skill tool. It also skips the share gate and tool wording overrides. The implementation notes claim it is "byte-for-byte what the model is sent".

9. **Docs are stale.**
   - `docs/features/custom-prompts.md:68` says prompts are attached through Settings → Agents; agents carry no prompt. The only UI path is the project-card launcher, plus REST and the `update_chat` tool.
   - Line 109 lists `chats` and `mouaif` as valid preset names; both are dropped on save.

## Recommended changes

The root problem is that there is no way to express "new chats from this prompt start with these tools". Make the preset a creation-time seed: when a chat is created with a `promptId`, copy `preset.tools` into `chat.tools` and the two booleans into the chat's toggles, then stop merging per turn. That fixes 1, 2, 3 and 6 together, and the popup then shows the truth because it reads the stored chat. The catch is that re-attaching a prompt to an existing chat needs an explicit rule (reseed or leave alone).

Findings 4 and 5 are small independent fixes: accept the file leaf names, and expand or drop the wildcard. Finding 7 is a product call on whether "Chat" should also strip tools and context.

## Outcome (2026-11-14)

Done, following the recommendation above:

- **1, 2, 3, 6.** The preset is a creation-time seed. `chats.createChat` copies `preset.tools`, `agentFiles` and `skills` onto the chat (`prompts.presetSeed`); explicit create options win. The per-turn merge (`effectivePresetConfig`) is gone from the stream, the system-prompt preview and the tool preview. The re-attach rule: PATCHing `promptId` onto a chat with no messages reseeds it; a chat with messages keeps its settings; detaching changes nothing. The editor sends `agentFiles` / `skills` only when checked. The tree's default-off rows were dropped, so a fresh preset shows every tool checked, which is what a chat gets.
- **4.** `PRESET_TOOL_NAMES` holds the file leaf names; a legacy `file` expands to them. An explicit empty `tools` list is kept and means "start with no tools".
- **5.** The per-chat allowlist matches `mcp__<slug>__*` against every tool of that server (`toolListed` in `src/ai-stream.js`), in the advertised list and in the execution check. This also covers the chat Tools card, which writes the same wildcard.
- **8.** The stream's tool collection is `ai.collectToolSpecs`, and the tool preview calls it.
- **9.** `docs/features/custom-prompts.md` describes the real attach paths and the valid names.

Not done: **7** is still a product call.

Tests: `scripts/test-prompt-preset-seed.js` (new), `scripts/test-preset-tools.js` (rewritten), `scripts/test-agent-skills-stream.js`, `scripts/test-group-cli.js`. Checked in the Docker test app: a chat created from a preset prompt stores the preset tools, its preview lists only those, and the editor reloads the file rows checked.
