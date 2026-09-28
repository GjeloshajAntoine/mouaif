# New-project folder picker

## Overview

The folder picker allows you to browse local directories and register any codebase as a project in mouaif, or create a brand-new directory in one tap. When you add a folder you also choose **where that project's settings live**: a `.mouaif.json` at the folder root, the same file inside a `.mouaif/` folder, or the app database so the folder stays untouched.

## Usage

1. In the **Projects** (Chats) tab, tap **+ Add project**.
2. Browse your folder tree — the folder list is the first thing on the page:
   - Tap a folder to open it.
   - Tap **↑** (next to the current path) to go to the parent folder.
3. Pick where the settings live in the bar pinned to the bottom of the screen (see below). A one-line note under it says exactly what will happen to the folder you are in.
4. Tap **Add "<folder>"** to register the folder you are in. The button always names the folder it acts on.
5. **Create a new folder** — expand *Create new folder* under the list, enter a name, and tap **Create**. The new folder is opened so you can add it.

## Where a project's settings live

The three options sit in a segmented control above the **Add** button:

| Option | File | What happens |
| --- | --- | --- |
| **`.mouaif.json`** (default) | `<folder>/.mouaif.json` | The settings file sits at the folder root. Written now with the project's name, ready to commit and hand-edit. |
| **`.mouaif/`** | `<folder>/.mouaif/.mouaif.json` | Same file, same name, inside a `.mouaif/` folder. For complex projects that want every mouaif file (config, traces) in one folder instead of the root. |
| **App DB** | none | Settings are kept in the app SQLite store (`~/.mouaif/store.sqlite`). **Nothing is written** to the folder, so nothing shows up in git. |

If the folder **already** has a config file (in either place), it is **adopted as-is**: never overwritten, moved, or duplicated, even if you picked the other file option. The note says `Uses the existing …` when that is the case.

Rows for folders that already contain a config file show a small badge — `.mouaif.json` or `.mouaif/` — so you can see an existing config before opening the folder.

### Which file is read

A project uses `<folder>/.mouaif/.mouaif.json` when that file exists, otherwise `<folder>/.mouaif.json`. There is no separate switch: to change layout later, move the file.

## Behavior

- **Safety & clean view** — hidden folders (dotfiles such as `.git`, `.cache`, or `.mouaif`) are filtered out to keep the picker clean. A folder's config file is still reported as a badge.
- **Non-destructive** — unregistering a project from mouaif only removes it from your project list; your files and folders on disk are never deleted. Adopting an existing config file leaves its bytes untouched.
- **Corrupt config file** — adopting a `.mouaif.json` that does not parse fails with a parse error rather than overwriting your bytes. Repair the file (or register with **App DB**) and try again.
- **Home directory default** — the picker starts at your user home directory and lets you navigate into any workspace.

## Related

- [Project card](./project-card.md) — managing registered projects and project chats.
- [Project settings storage](./project-settings-storage.md) — moving an existing project between the config file and the app database.
- [App and project settings](./app-and-project-settings.md) — the defaults → app → project resolution order.
