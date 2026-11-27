// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, props, run, theme, home, layout, readTextFile } from "herdr";

const isPathTitle = (s) => /^[~/]|^[A-Za-z]:\\/.test((s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));

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
  const labeled = typeof term.labels?.["agy.title"] === "string" ? term.labels["agy.title"].trim() : "";
  // Antigravity puts the reply snippet in report.msg when idle/done; only trust report.msg while working.
  const workingMsg = term.status === "working" && typeof term.report?.msg === "string" ? term.report.msg.trim() : "";
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

function agentTitle(p, cache) {
  const raw = (p.title ?? "").trim();
  const prog = p.program?.name;
  const telling = raw && raw !== p.terminal && raw !== prog && !isPathTitle(raw) && !raw.includes("@") && raw.toLowerCase() !== p.program?.key;
  if (telling) return raw;
  const term = p.terminal ? terminals().find((t) => t.address === p.terminal) : null;
  const msg = resolveReportMsg(term, cache);
  if (msg) return msg;
  return prog || "shell";
}

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.ctxPct = null;
    this.alive = true;
    this.titleCache = readTitleCache();
    const poll = async () => {
      const p = this.me();
      if (!p?.program?.agent || !p?.terminal) {
        if (this.ctxPct !== null) { this.ctxPct = null; cx.notify(); }
        return;
      }
      const safe = String(p.terminal).replace(/[^A-Za-z0-9._-]/g, "_");
      const file = `${home().replace(/[\\/]+$/, "")}/.omp/run/herdr-subagents/${safe}.json`;
      try {
        const raw = await readTextFile(file, { on: null });
        const data = JSON.parse(raw);
        const next = typeof data?.contextPercent === "number" && Number.isFinite(data.contextPercent) ? Math.round(data.contextPercent) : null;
        if (next !== this.ctxPct) { this.ctxPct = next; cx.notify(); }
      } catch {
        if (this.ctxPct !== null) { this.ctxPct = null; cx.notify(); }
      }
    };
    cx.spawn(async () => {
      while (this.alive) {
        await poll();
        await new Promise((r) => setTimeout(r, 1500));
      }
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = p.name || (p.program?.agent ? agentTitle(p, this.titleCache ?? (this.titleCache = readTitleCache())) : (p.program?.shell && p.program.name)) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(520).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(p.program?.agent && this.ctxPct !== null, el => el.child(div().flex_none().text_size(11).text_color(this.ctxPct >= 90 ? t.error : this.ctxPct >= 80 ? t.warning : t.dim).child(`${this.ctxPct}%`)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
