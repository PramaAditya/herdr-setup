// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, HoverCard } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, hc, home } from "herdr";

const OMP_SESSIONS_SCRIPT = `
const fs = require("fs"), path = require("path");
const cwd = process.argv[1], homeDir = process.argv[2];
const base = path.join(homeDir, ".omp", "agent", "sessions");
const norm = (s) => s.replace(/\\\\/g, "/").replace(/\\/+$/, "");
const nCwd = norm(cwd), nHome = norm(homeDir);
const cands = [];
if (nCwd.toLowerCase().startsWith(nHome.toLowerCase() + "/")) {
  const rel = nCwd.slice(nHome.length + 1).replace(/[/:\\\\]/g, "-");
  cands.push("-" + rel);
}
cands.push("--" + nCwd.replace(/:/g, "-").replace(/[\\/\\\\]/g, "-") + "--");
let dir = null;
for (const c of cands) {
  const p = path.join(base, c);
  if (fs.existsSync(p)) { dir = p; break; }
}
if (!dir) { console.log("[]"); process.exit(0); }
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => { const full = path.join(dir, f); return { f, full, mtime: fs.statSync(full).mtimeMs }; })
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 5);
const out = files.map(({ f, full, mtime }) => {
  const m = /_([0-9a-f-]+)\\.jsonl$/i.exec(f);
  const uuid = m ? m[1] : f.replace(/\\.jsonl$/, "");
  let title = "";
  try {
    const fd = fs.openSync(full, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const lines = buf.toString("utf8", 0, n).split(/\\r?\\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.title && typeof obj.title === "string") { title = obj.title; break; }
        if (obj.type === "message" && obj.message?.role === "user") {
          const c = obj.message.content;
          if (typeof c === "string") title = c;
          else if (Array.isArray(c)) title = c.map((x) => x?.text || "").join(" ");
          if (title) break;
        }
      } catch {}
    }
  } catch {}
  title = title.replace(/\\s+/g, " ").trim().slice(0, 48);
  return { uuid, title: title || uuid.slice(0, 8), mtime };
});
console.log(JSON.stringify(out));
`;

async function listOmpSessions(cwd) {
  if (!cwd) return [];
  const res = await exec("node", ["-e", OMP_SESSIONS_SCRIPT, cwd, home()]);
  if (res?.code !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shortAge(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function items(p, git, ompSessions = []) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["Rename", "pane.rename", { pane: tg.pane }],
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(ompSessions.length > 0 && term ? [["Resume OMP", "omp.resume.menu", { terminal: term.address }]] : []),
        ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command, args) {
  if (command === "omp.resume.menu" || command === "omp.resume") return "icons/omp.svg";
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? (args?.direction === "down" ? "panel-bottom" : "panel-right") : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.ompSessions = [];
    this.submenu = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
    if (p?.tab === "pane" && p.target?.terminal && !p.target.terminal.includes("/")) {
      const pane = panes().find((x) => x.pane === p.target.pane);
      const isIdleShell = !pane?.program?.agent;
      if (isIdleShell && pane?.cwd) {
        cx.spawn(async (cx) => {
          this.ompSessions = await listOmpSessions(pane.cwd).catch(() => []);
          cx.notify();
        });
      }
    }
  }

  choose(i, cx) {
    if (this.submenu === "omp") {
      if (i === 0) {
        this.submenu = null;
        this.at = 0;
        cx.notify();
        return;
      }
      const sess = this.ompSessions[i - 1];
      const term = props()?.target?.terminal;
      if (sess && term) {
        closeOverlay(props()?.overlay);
        hc(["send", term, `omp --resume ${sess.uuid}`]);
      }
      return;
    }
    const it = items(props(), this.git, this.ompSessions)[i];
    if (!it) return;
    if (it[1] === "omp.resume.menu") {
      this.submenu = "omp";
      this.at = 1;
      cx.notify();
      return;
    }
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const inSub = this.submenu === "omp";
    const list = inSub
      ? [["← Back", "back", {}], ...this.ompSessions.map((s) => [s.title, "omp.resume", s])]
      : items(props(), this.git, this.ompSessions);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at - 1 + list.length) % list.length;
        else if (e.key === "right" && !inSub && list[this.at]?.[1] === "omp.resume.menu") { this.submenu = "omp"; this.at = 1; }
        else if (e.key === "left" && inSub) { this.submenu = null; this.at = 0; }
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") {
          if (inSub) { this.submenu = null; this.at = 0; }
          else closeOverlay(props().overlay);
        }
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) => {
          const isFlyout = !inSub && it[1] === "omp.resume.menu";
          const row = h_flex()
            .id(`mi-${inSub ? "sub-" : ""}${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(it[1] === "back" ? t.muted : t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .when(it[1] !== "back", (el) => el.child(svg(menuIcon(it[1], it[2])).size(14).flex_none().text_color(t.muted)))
            .child(div().flex_1().min_w(0).truncate().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(
              it[1] === "omp.resume.menu" ? "▸" : it[1] === "omp.resume" ? shortAge(it[2].mtime) : shortcut(it[1], it[2])
            ));

          const flyout = isFlyout
            ? HoverCard.new("omp-resume-flyout")
                .anchor("top_right")
                .open_delay(80)
                .close_delay(220)
                .trigger(row)
                .content(
                  v_flex()
                    .w(248)
                    .p(5)
                    .rounded(8)
                    .bg(t.popover)
                    .border(1)
                    .border_color(t.border)
                    .text_size(12.8)
                    .children(
                      this.ompSessions.map((sess, idx) =>
                        h_flex()
                          .id(`omp-flyout-${idx}`)
                          .h(31)
                          .px(8)
                          .gap(9)
                          .rounded(7)
                          .items_center()
                          .cursor_pointer()
                          .text_color(t.foreground)
                          .hover((s) => s.bg(t.hover))
                          .on_click(() => {
                            const term = props()?.target?.terminal;
                            closeOverlay(props()?.overlay);
                            if (term) hc(["send", term, `omp --resume ${sess.uuid}`]);
                          })
                          .child(svg("icons/omp.svg").size(14).flex_none().text_color(t.muted))
                          .child(div().flex_1().min_w(0).truncate().child(sess.title))
                          .child(div().text_size(11).text_color(t.dim).child(shortAge(sess.mtime)))
                      )
                    )
                )
            : row;

          return v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || it[1] === "omp.resume.menu" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(flyout);
        }),
      );
  }
}
