// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, run, props, shared, setShared, openOverlay, closeOverlay } from "herdr";
// The panels share data in one VM, but their host tasks belong to separate copies.
const scans = globalThis[Symbol.for("herdr.repoStatus.v2")] ??= new Map();

async function repoStatus(root, on, { after, visiting, urgent, allowInactive }, cx, current) {
  const repo = JSON.stringify([on, root]), now = Date.now();
  for (const [key, scan] of scans) {
    if (scan.pollAt <= now || (!scan.pollAt && scan.task.is_done())) scans.delete(key);
  }
  while (current()) {
    let scan = scans.get(repo);
    const pending = scan && !scan.pollAt && !scan.task.is_done();
    const reusable = scan?.status?.code === 0 && Date.now() < scan.pollAt
      && (scan.started >= after || (!urgent && Date.now() < scan.watchAt));
    if (!reusable && (!pending || (visiting && scan.started !== undefined && scan.started < after))) {
      if (!allowInactive && window()?.active === false) return null;
      const next = {};
      next.task = cx.spawn(async cx => {
        await cx.sleep(25); // Let both listeners for a watch batch join before starting Git.
        if (!allowInactive && window()?.active === false) return;
        next.started = Date.now();
        try {
          next.status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
        } catch (error) {
          next.error = error;
        } finally {
          const finished = Date.now(), duration = finished - next.started;
          const delay = duration < 500 ? 0 : Math.min(60000, 5 * duration);
          next.watchAt = finished + delay;
          next.pollAt = finished + Math.max(10000, delay);
          if (next.status?.code !== 0 && scans.get(repo) === next) scans.delete(repo);
        }
      });
      scans.set(repo, next);
      scan = next;
    }
    // Resume through our own host task, so another copy's close cannot cancel our follow-up work.
    while (current() && !scan.pollAt && !scan.task.is_done()) await cx.sleep(50);
    if (!current()) return null;
    if (!scan.pollAt) continue; // The scanning copy closed or reloaded.
    return scan;
  }
  return null;
}

function location(prev) {
  if (props()?.drawer) {
    const drawer = shared("customize.drawer");
    return { cwd: drawer?.folder || null, on: null, space: "customize-drawer" };
  }
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  if (!pane?.cwd && !f?.cwd && prev && prev.space === space?.id && prev.cwd) {
    return { cwd: prev.cwd, on: prev.on, space: prev.space };
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = (prev) => JSON.stringify(location(prev));
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    if (props()?.contextMenu) return;
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.createInput = InputState.new({ placeholder: "name..." });
    this.createInput.on("submit", (_e, cx) => this.commitCreate(cx));
    this.refresh(cx);
    cx.timer.every(500, cx => this.refreshIfDue(cx));
  }

  refreshIfDue(cx) {
    const active = window()?.active !== false, context = this.context;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!context) return;
    if (refocused && (context.dirtyAt || !context.watch)) context.catchUp = true;
    if (!active || this.loading) return;
    const now = Date.now();
    if (context.catchUp || (context.dirtyAt && now >= context.watchAt) || now >= context.pollAt) this.refresh(cx);
  }

  watch(root, context, cx) {
    if (context.on || context.watch?.root === root) return;
    context.watch?.pending?.cancel();
    const watch = { root };
    context.watch = watch;
    cx.spawn(async cx => {
      try {
        while (this.context === context && context.watch === watch) {
          watch.pending = watchFolder(root);
          const paths = await watch.pending;
          if (paths.length && context.watch === watch && this.current(context)) {
            context.dirtyAt = Date.now() + 1;
            this.refreshIfDue(cx);
          }
        }
      } catch {
        if (context.watch === watch) context.watch = null;
      }
    });
  }

  current(context) {
    return this.context === context && key(this.context) === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const loc = location(this.context), { cwd, on, space } = loc, next = JSON.stringify(loc);
    const visiting = next !== this.context?.key;
    if (visiting) {
      if (this.context) {
        this.saved.set(this.context.key, { folders: this.folders, file: this.file });
        this.context.watch?.pending?.cancel();
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, space, dirtyAt: 0 }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    const context = this.context;
    const now = Date.now();
    if (!cwd) {
      context.catchUp = false;
      context.dirtyAt = 0;
      context.pollAt = now + 10000;
      return;
    }
    if (this.loading) return;
    if (context.catchUp && !context.dirtyAt) context.dirtyAt = now + 1;
    const request = {
      after: visiting ? now + 1 : context.dirtyAt || (context.lastStatus ?? -1) + 1,
      visiting,
      urgent: visiting || context.catchUp,
      allowInactive: visiting,
    };
    context.catchUp = false;
    context.pollAt = context.watchAt = now + 10000;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        this.watch(cwd, context, cx);
        const dirtyAtListing = context.dirtyAt;
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        if (!this.current(context)) return;
        const marks = {};
        let covered = dirtyAtListing;
        if (top?.code === 0) {
          const root = top.stdout.trim();
          const scan = await repoStatus(root, on, request, cx, () => this.context === context);
          if (!scan || !this.current(context)) return;
          const { status, started, pollAt, watchAt } = scan;
          context.lastStatus = started;
          context.pollAt = pollAt;
          context.watchAt = watchAt;
          covered = Math.min(dirtyAtListing, started);
          if (request.urgent && request.after > started) context.catchUp = true;
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${root}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        } else {
          context.watchAt = Date.now();
        }
        if (!this.current(context)) return;
        if (context.dirtyAt <= covered) context.dirtyAt = 0;
        this.marks = marks; this.error = null;
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path) {
    if (!path || !this.root) return;
    const fullPath = `${this.root}/${path}`;
    const name = path.split(/[\\/]/).pop() || path;
    const space = spaces().find(s => s.active);
    const existing = space?.tabs.find(t => t.named && t.name === name && panes().some(p => p.tab === t.id && !p.terminal));
    if (existing) {
      run("tab.select", { id: existing.id });
      return;
    }
    run("tab.new", {
      name,
      space: space?.id,
      mod: "file-viewer",
      props: { path: fullPath, label: path, on: this.on },
    });
  }

  startCreate(kind, parent, cx) {
    if (parent && !this.folders.has(parent)) {
      this.toggle(parent, cx);
    }
    this.createInput.set_value("");
    this.creating = { kind, parent: parent || "", input: this.createInput, error: null };
    this.createInput.focus();
    cx.notify();
  }

  cancelCreate(cx) {
    this.creating = null;
    if (cx) cx.notify();
  }

  commitCreate(cx) {
    const c = this.creating;
    if (!c || !this.root) return;
    const rawName = c.input.value().trim().replace(/^[\\/]+|[\\/]+$/g, "");
    if (!rawName || rawName.includes("..")) {
      c.error = "Invalid name";
      cx.notify();
      return;
    }
    const relPath = c.parent ? `${c.parent}/${rawName}` : rawName;
    const fullPath = `${this.root.replace(/[\\/]+$/, "")}/${relPath}`;
    const kind = c.kind;
    const on = this.on;
    const isWin = !on && window()?.platform === "windows";
    const root = this.root;

    cx.spawn(async (cx) => {
      try {
        if (kind === "folder") {
          const res = isWin
            ? await exec("powershell", ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${fullPath.replace(/'/g, "''")}' | Out-Null`], { cwd: root, on })
            : await exec("mkdir", ["-p", fullPath], { cwd: root, on });
          if (res?.code !== 0) throw new Error(res?.stderr || "Failed to create folder");
          this.folders.add(relPath);
        } else {
          const lastSlash = fullPath.lastIndexOf("/");
          const parentDir = lastSlash > 0 ? fullPath.slice(0, lastSlash) : root;
          if (isWin) {
            await exec("powershell", ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${parentDir.replace(/'/g, "''")}' | Out-Null`], { cwd: root, on });
          } else {
            await exec("mkdir", ["-p", parentDir], { cwd: root, on });
          }
          if (!on) {
            await writeTextFile(fullPath, "", null);
          } else {
            await exec("touch", [fullPath], { cwd: root, on });
          }
        }
        this.cancelCreate();
        await this.loadFolder(c.parent, this.context);
        if (kind === "file") this.show(relPath);
        cx.notify();
      } catch (err) {
        if (this.creating === c) {
          c.error = String(err?.message || err || "Already exists or failed");
          cx.notify();
        }
      }
    });
  }

  contextMenu(t, menu) {
    const trigger = (kind) => {
      setShared("files.create", {
        drawer: Boolean(menu.drawer),
        parent: menu.parent || "",
        kind,
        ts: Date.now(),
      });
      closeOverlay(props().overlay);
    };
    const item = (id, icon, label, kind) =>
      h_flex()
        .id(id)
        .h(30)
        .px(9)
        .gap(8)
        .rounded(7)
        .items_center()
        .cursor_pointer()
        .text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click(() => trigger(kind))
        .child(svg(`mods/files/${icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(label));
    return v_flex()
      .w_full()
      .p(5)
      .gap(2)
      .bg(t.popover)
      .text_size(12.8)
      .when(Boolean(menu.parent), (el) =>
        el.child(div().px(9).pt(3).pb(4).truncate().text_size(11).text_color(t.dim).child(menu.parent))
      )
      .child(item("ctx-new-file", "file", "New File", "file"))
      .child(item("ctx-new-folder", "folder", "New Folder", "folder"));
  }

  openMenu(parent, cx) {
    cx.stop_propagation();
    openOverlay({
      mod: "files-edited",
      kind: "popup",
      width: 190,
      height: parent ? 96 : 74,
      props: { contextMenu: { parent: parent || "", drawer: Boolean(props()?.drawer) } },
    });
  }

  createRow(depth, t) {
    const c = this.creating;
    return v_flex()
      .id("files-inline-create")
      .pl(8 + depth * 18)
      .pr(8)
      .py(2)
      .gap(2)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.cancelCreate(cx);
        }
      })
      .child(
        h_flex()
          .h(26)
          .gap(6)
          .items_center()
          .child(div().w(12).flex_none())
          .child(svg(`mods/files/${c.kind === "folder" ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.accent))
          .child(
            Input.new(c.input)
              .flex_1()
              .min_w(0)
              .h(24)
              .px(6)
              .rounded(5)
              .bg(t.input)
              .border(1)
              .border_color(c.error ? t.blocked : t.accent)
              .text_size(12.5)
              .text_color(t.foreground)
          )
      )
      .when(Boolean(c.error), (el) =>
        el.child(div().pl(32).text_size(10.5).text_color(t.blocked).child(c.error))
      );
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    if (this.creating && this.creating.parent === prefix) {
      out.push(this.createRow(depth, t));
    }
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const targetParent = entry.dir ? path : prefix;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => this.openMenu(targetParent, cx))
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    const t = theme();
    if (props()?.contextMenu) return this.contextMenu(t, props().contextMenu);

    const req = shared("files.create");
    if (req && req.ts !== this.lastCreateTs && Boolean(req.drawer) === Boolean(props()?.drawer)) {
      this.lastCreateTs = req.ts;
      this.startCreate(req.kind, req.parent, cx);
    }

    if (key(this.context) !== this.context?.key) this.refresh(cx);
    else this.refreshIfDue(cx);
    const font = this.code ? settings() : null;
    const actionBtn = (id, icon, tip, kind) =>
      div()
        .id(id)
        .size(22)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .cursor_pointer()
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tip)
        .on_click((_e, cx) => this.startCreate(kind, "", cx))
        .child(svg(icon).size(13));

    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.root), (el) => el
          .child(actionBtn("files-new-file", "mods/files/file.svg", "New File", "file"))
          .child(actionBtn("files-new-folder", "mods/workspace-chrome/folder-plus.svg", "New Folder", "folder"))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_mouse_down("right", (_e, cx) => this.openMenu("", cx))
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code
        ? Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
