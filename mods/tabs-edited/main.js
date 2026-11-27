import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { checking, nextCommand, spaces, panes, terminals, focused, exec, run, openOverlay, theme, window, shared, setShared, layout, settings } from "herdr";

function normPath(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

const TITLE_CACHE_KEY = "agent.session.titles";

function readTitleCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TITLE_CACHE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveReportMsg(term, cache) {
  if (!term?.address) return "";
  const key = `${term.address}:${term.program?.key ?? ""}`;
  const labeled = clean(term.labels?.["agy.title"]);
  // Antigravity puts the reply snippet in report.msg when idle/done; only trust report.msg while working.
  const workingMsg = term.status === "working" ? clean(term.report?.msg) : "";
  const fresh = labeled || workingMsg;
  if (fresh) {
    if (cache[key] !== fresh) {
      cache[key] = fresh;
      try { localStorage.setItem(TITLE_CACHE_KEY, JSON.stringify(cache)); } catch {}
    }
    return fresh;
  }
  return typeof cache[key] === "string" ? cache[key] : "";
}

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead, terms, titleCache) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  const msg = resolveReportMsg(terms?.get(lead.terminal), titleCache);
  const resolved = telling ? live : (msg && msg !== prog && msg.toLowerCase() !== lead.program.key ? msg : "");
  return (tab.name === prog || !tab.named) && resolved ? resolved : base;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    this.kanbanCache = new Map();
    this.kanbanPending = new Set();
    this.stripW = 0;
    this.tabWidths = new Map();
    if (cx && !checking()) {
      cx.spawn(async () => {
        for (;;) {
          let cmd;
          try { cmd = await nextCommand(); } catch { break; }
          if (cmd === "toggle-todoist") {
            const root = layout();
            const panel = find(root, "panel");
            const body = find(root, "panel-body");
            if (panel && !panel.hidden && body?.active === "todoist") {
              run("layout.hide", { id: "panel" });
            } else {
              run("layout.select", { stack: "panel-body", child: "todoist" });
              run("layout.show", { id: "panel" });
              setShared("todoist.focusQuickAdd", Date.now());
            }
          } else if (cmd === "toggle-browser") {
            const root = layout();
            const panel = find(root, "panel");
            const body = find(root, "panel-body");
            if (panel && !panel.hidden && body?.active === "browser") {
              run("layout.hide", { id: "panel" });
            } else {
              run("layout.select", { stack: "panel-body", child: "browser" });
              run("layout.show", { id: "panel" });
              setShared("browser.focusUrl", Date.now());
            }
          }
        }
      });
    }
  }

  hasKanban(cwd, on, cx) {
    if (!cwd) return false;
    const key = `${on ?? ""}:${normPath(cwd)}`;
    if (this.kanbanCache.has(key)) return this.kanbanCache.get(key);
    if (!this.kanbanPending.has(key) && cx) {
      this.kanbanPending.add(key);
      const isWin = !on && window()?.platform === "windows";
      cx.spawn(async (cx) => {
        let ok = false;
        try {
          const res = isWin
            ? await exec("powershell", ["-NoProfile", "-Command", "Test-Path -LiteralPath '.kanban' -PathType Container"], { cwd, on })
            : await exec("test", ["-d", ".kanban"], { cwd, on });
          ok = isWin ? res?.stdout?.trim() === "True" : res?.code === 0;
        } catch {
          ok = false;
        }
        this.kanbanCache.set(key, ok);
        this.kanbanPending.delete(key);
        cx.notify();
      });
    }
    return false;
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const terms = new Map(terminals().map(term => [term.address, term]));
    const titleCache = this.titleCache ?? (this.titleCache = readTitleCache());
    const item = (c, i, inScroll = true) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead, terms, titleCache);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // Track each tab's rendered width so `+` hugs the last tab when everything fits and pins right on overflow.
        .on_size_change((size, cx) => {
          const prev = this.tabWidths.get(c.id) ?? 0;
          const changed = Math.abs(size.width - prev) > 1;
          if (changed) this.tabWidths.set(c.id, size.width);
          if (inScroll && i <= active) this.scroll.scroll_to_item(active);
          if (changed || (inScroll && i <= active)) cx.notify();
        })
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = c.id; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== c.id) run("tab.move", { id: from, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu-edited", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const f = focused();
    const activePane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
    let activeCwd = activePane?.cwd || f?.cwd || null;
    if (activeCwd) {
      this.lastCwd = { space: space?.id, cwd: activeCwd };
    } else if (space?.id && this.lastCwd?.space === space.id) {
      activeCwd = this.lastCwd.cwd;
    } else {
      activeCwd = space?.folder || null;
    }
    const on = space?.machine ?? null;
    const showKanban = this.hasKanban(activeCwd, on, cx);
    if (!showKanban && panel && !panel.hidden && body?.active === "kanban") {
      run("layout.hide", { id: "panel" });
    }
    const baseEnabled = shared("workspace.panels") ?? ["files", "changes"];
    const enabled = [...(showKanban ? ["kanban"] : []), "browser", "todoist", ...baseEnabled];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    const newTabBtn = () => button("tab-new", "+", () => openOverlay({ mod: "new-menu-edited", kind: "popup", width: 250, height: 512 }));
    const measuredTabsW = shown.reduce((sum, c) => sum + (this.tabWidths.get(c.id) ?? 0), 0) + Math.max(0, shown.length - 1) * 3;
    const allMeasured = shown.length > 0 && shown.every(c => (this.tabWidths.get(c.id) ?? 0) > 0);
    // Pin `+` to the right edge of the tab strip once tabs overflow; otherwise keep it right beside the last tab.
    const overflowing = allMeasured && this.stripW > 0 && (measuredTabsW + 30 > this.stripW);
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(
        h_flex().id("tab-strip-wrap").flex_1().min_w(0).h_full().items_center().gap(3)
          .on_size_change((size, cx) => {
            if (Math.abs(size.width - this.stripW) > 1) {
              this.stripW = size.width;
              cx.notify();
            }
          })
          .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
            .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
            .children(shown.map((c, i) => item(c, i, true)))
            .when(!overflowing, el => el.child(newTabBtn())))
          .when(overflowing, el => el.child(
            h_flex().flex_none().h(20).pl(4).items_center().border_l(1).border_color(t.border)
              .child(newTabBtn())
          ))
      )
      .when(showKanban, el => el.child(panelButton("kanban", "Kanban", "mods/workspace-chrome/layers.svg")))
      .child(panelButton("browser", "Artifact Viewer", "mods/browser/globe.svg"))
      .child(panelButton("todoist", "Todoist", "mods/workspace-chrome/circle-check.svg"))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
