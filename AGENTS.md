# Herdr Setup Rules

- **NEVER edit built-in `mods/*` or built-in `layouts/*` directly.** Herdr protects its own built-in mods and layouts: any direct edit will be overwritten/reset by Herdr (and backed up to `mods/*-edited/`).
- **Always use cloned `*-edited` mods** (e.g., `mods/pane-edited/`, `mods/spaces-edited/`, `mods/tabs-edited/`, `mods/agents-edited/`, `mods/files-edited/`) and reference them from `layouts/custom.json`.
