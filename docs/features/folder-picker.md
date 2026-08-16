# New-project folder picker

## Overview

The folder picker allows you to browse local directories and register any codebase as a project in mouaif, or create a brand-new directory in one tap.

## Using the folder picker

1. In the **Projects** (Chats) tab, tap **+ Add project**.
2. Browse your folder tree:
   - Tap **Open** on any folder to view its subdirectories.
   - Tap **Up** to navigate to the parent folder.
   - Tap **Select this folder** or the **Select** button next to any folder name to register it immediately.
3. **Create a new folder** — enter a name in the *Create new folder* input at the bottom and tap create. The folder is created on disk and opened immediately so you can select and register it.

## Behavior

- **Safety & clean view** — hidden folders (dotfiles such as `.git` or `.cache`) are filtered out to keep the picker clean.
- **Non-destructive** — unregistering a project from mouaif only removes it from your project list; your files and folders on disk are never deleted.
- **Home directory default** — the picker starts at your user home directory and lets you navigate into any workspace.

## Related

- [Project card](./project-card.md) — managing registered projects and project chats.
- [Projects in Settings](./projects-in-settings.md) — viewing and organizing all registered projects.
