<h1 align="center">herdr-setup</h1>

<p align="center">
  <b>My personal <a href="https://herdr.dev">Herdr</a> setup — changes frequently.</b>
  <br>
  Custom GPUI mods, layout, keybindings, and OMP subagent integration.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/workspace-Herdr-0ea5e9?style=flat-square" alt="Herdr">
  <img src="https://img.shields.io/badge/theme-dark-18181b?style=flat-square" alt="Dark Theme">
</p>

<br>

---

This is my daily-driver [Herdr](https://herdr.dev) config (`~/.config/herdr-app`). I tweak it constantly as my workflow evolves, so things here may change without notice.

## Restore on a New Machine

Launch [Herdr](https://herdr.dev) once so it initializes `~/.config/herdr-app`, close it, then pull this repo:

```bash
cd ~/.config/herdr-app
git init
git remote add origin https://github.com/PramaAditya/herdr-setup.git
git fetch origin
git checkout -f main
```

- **Todoist panel (optional):** create `~/.config/herdr-app/.env` with `TODOIST_API_TOKEN=...`
- **OMP subagent peek (optional):** requires the `herdr-subagents` extension in `~/.omp/agent/extensions/herdr-subagents/`

> **Note on Shipped Mods:** Herdr may move edited shipped mods to `<name>-edited` on app updates. Check `git diff` and reapply if needed.
