# Herdr Setup

Personal [Herdr](https://herdr.dev) configuration, custom layout, themes, and mods.

## What's Included

| Path | Description |
| --- | --- |
| `settings.json` | Core Herdr app settings (theme, font, zoom, layout) |
| `keys.json` | Custom keybindings |
| `themes/` | Custom color themes |
| `layouts/custom.json` | Custom workspace layout |
| `mods/tabs/` | Top tab bar with persistent icon-only `Customize Herdr` & `Customize OMP` tabs on the right of `+` |
| `mods/agents/` | Agents sidebar hiding customize tabs + live OMP subagent subtree (max 3 shown, expand/collapse) |
| `mods/omp-peek/` | Read-only live overlay to inspect running OMP subagents without pausing the main OMP thread |
| `mods/files/` | Files panel configured to open clicked files in a main tab while preserving the current folder |
| `mods/file-viewer/` | Read-only main-tab file viewer with syntax highlighting and reload |
| `mods/herdr-omp/` | Legacy/optional Customize popover mod (kept for reference, not mounted in `layouts/custom.json`) |

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

Ensure `~/.omp/agent/extensions/herdr-subagents/` exists (restore from your OMP extensions repo, or verify `package.json` + `index.ts` are installed there).

### 4. Launch Herdr
Start Herdr. It will automatically pick up `settings.json`, `keys.json`, `layouts/custom.json`, `themes/`, and all `mods/`.

> **Note on Shipped Mods:** Herdr may move edited shipped mods (`tabs`, `agents`, `files`) to `<name>-edited` on app updates. If an update resets a shipped mod, compare with `git diff` and reapply.
