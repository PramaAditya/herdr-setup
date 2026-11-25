# Herdr Setup

Personal [Herdr](https://herdr.dev) configuration, custom layout, themes, and mods.

## What's Included

| Path | Description |
| --- | --- |
| `settings.json` | Core Herdr app settings (theme, font, zoom, layout) |
| `keys.json` | Custom keybindings |
| `themes/` | Custom color themes |
| `layouts/custom.json` | Custom workspace layout with bottom `customize-drawer` split and `todoist` / `kanban` / `files` / `changes` panels |
| `mods/tabs/` | Top tab bar with auto-detected `Kanban` button, `Todoist`, `Files`, and `Changes` panel toggles |
| `mods/herdr-omp/` | Flex fill-width icon-only sidebar dock (`Herdr` / `OMP`) above Settings that toggles the bottom `customize-drawer` |
| `mods/customize-drawer/` | Bottom split drawer header with `Herdr` / `OMP` switcher, dedicated drawer `Files` toggle, and close button |
| `mods/spaces/` | Spaces sidebar hiding the dedicated `__customize__` space |
| `mods/agents/` | Agents sidebar hiding customize tabs, live OMP subagent subtree (max 3 + expand/collapse), and right-click `Copy OMP session ID` |
| `mods/omp-peek/` | Read-only live overlay to inspect running OMP subagents without pausing the main OMP thread |
| `mods/kanban/` | Read-only `.kanban/` board panel (auto-detected per project; opens cards in `file-viewer`) |
| `mods/todoist/` | Todoist API v1 active tasks panel (newest first, check-off, `Copy`, quick-add; reads `TODOIST_API_TOKEN` from `.env`) |
| `mods/files/` | Files panel with right-click & header inline `New File` / `New Folder`, opening files in `file-viewer` (also supports drawer mode) |
| `mods/file-viewer/` | Editable main-tab file editor with syntax highlighting, dirty indicator, `Ctrl+S` / `Save`, and `Reload` |
| `mods/new-menu/` | `+` menu ordered with `oh-my-pi` (#1), `Antigravity` (#2), and `Gemini` hidden |
| `mods/toast/` | Toast notifications with `<Space> / ` prefix stripped for `Customize Herdr` & `Customize OMP` |

## Restore on a New Machine (Agent-Friendly)

> **For OMP / AI Agents:** Follow the steps below to restore this Herdr setup on the current machine.

### 1. Prerequisites
- Install **Herdr** and launch it once so `~/.config/herdr-app` is initialized (generates `icons/`, `frame/`, `*.d.ts`, etc.).
- Install **OMP** (`omp` CLI available on `PATH`).

### 2. Restore Herdr Config & Mods
Clone or copy this repository into Herdr's config directory (`~/.config/herdr-app` on macOS/Linux/Windows):

```bash
# Close Herdr first if it is running
cd ~/.config/herdr-app

# Option A: Clone directly into an existing herdr-app folder
git init
git remote add origin <REPO_URL>
git fetch origin
git checkout -f main
```

### 3. Install the Companion OMP Extension (for Subagent Peek)
The OMP subagent subtree in `mods/agents/` and `mods/omp-peek/` reads live state written by the `herdr-subagents` OMP extension at `~/.omp/run/herdr-subagents/<HC_TERMINAL_ID>.json`.


### 3b. Optional: Configure Todoist Token
Create `~/.config/herdr-app/.env` (gitignored) with your Todoist API token:

```env
TODOIST_API_TOKEN=your_todoist_api_token_here
```
Ensure `~/.omp/agent/extensions/herdr-subagents/` exists (restore from your OMP extensions repo, or verify `package.json` + `index.ts` are installed there).

### 4. Launch Herdr
Start Herdr. It will automatically pick up `settings.json`, `keys.json`, `layouts/custom.json`, `themes/`, and all `mods/`.

> **Note on Shipped Mods:** Herdr may move edited shipped mods (`tabs`, `agents`, `files`) to `<name>-edited` on app updates. If an update resets a shipped mod, compare with `git diff` and reapply.
