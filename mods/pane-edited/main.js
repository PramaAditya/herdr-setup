// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, props, run, theme, home, layout, readTextFile, checking, exec, hc, openOverlay, shared, window } from "herdr";

const AGY_CACHE_KEY = "agy-auth.cache";
const AGY_WIN_BIN = "C:\\nvm4w\\nodejs\\node_modules\\@fikrilal\\agy-auth\\npm\\vendor\\agy-auth-win32-x64.exe";

async function readLiveAgyAlias() {
  const isWin = window()?.platform === "windows";
  const candidates = isWin ? [AGY_WIN_BIN, "agy-auth.cmd", "agy-auth"] : ["agy-auth"];
  for (const bin of candidates) {
    try {
      const res = await exec(bin, ["list", "--no-usage", "--no-sync", "--json"], { timeout: 6000 });
      if (res?.code === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout);
        const cur = parsed?.data?.current ?? (parsed?.data?.accounts ?? []).find((a) => a.active) ?? null;
        if (cur) return cur.alias || (cur.email ? cur.email.split("@")[0] : cur.id) || null;
      }
    } catch {
      // try next candidate
    }
  }
  return shared(AGY_CACHE_KEY)?.activeAlias ?? null;
}

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
    this.wasAgy = false;
    this.needsRestamp = false;
    this.stamping = false;
    this.stampedAccount = null;
    this.titleCache = readTitleCache();
    if (checking()) return;
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

  stampAgyAccount(termAddr, cx) {
    if (!termAddr || termAddr.includes("/") || this.stamping || checking()) return;
    this.stamping = true;
    this.needsRestamp = false;
    cx.spawn(async (cx) => {
      try {
        const alias = await readLiveAgyAlias();
        if (alias) {
          this.stampedAccount = alias;
          await hc(["label", termAddr, `agy.account=${alias}`]);
          cx.notify();
        }
      } catch {
        // best-effort label stamping
      } finally {
        this.stamping = false;
      }
    });
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
    const isAgy = p.program?.key === "antigravity";
    const term = p.terminal ? terminals().find((x) => x.address === p.terminal) : null;
    const labeledAccount = typeof term?.labels?.["agy.account"] === "string" ? term.labels["agy.account"].trim() : "";

    if (!isAgy && this.wasAgy) {
      this.needsRestamp = true;
      this.stampedAccount = null;
    }
    this.wasAgy = isAgy;
    if (isAgy && p.terminal && ((!labeledAccount && !this.stampedAccount) || this.needsRestamp)) {
      this.stampAgyAccount(p.terminal, cx);
    }

    const agyAccount = isAgy ? (labeledAccount || this.stampedAccount || null) : null;
    const globalAlias = shared(AGY_CACHE_KEY)?.activeAlias ?? null;
    const agyStale = Boolean(agyAccount && globalAlias && agyAccount !== globalAlias);
    const agyBadgeTip = agyStale
      ? `Running as ${agyAccount} · global is now ${globalAlias} (restart agy to switch)`
      : agyAccount
        ? `Antigravity CLI account: ${agyAccount} (matches global) — click to manage`
        : "";
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
      .when(Boolean(agyAccount), el => el.child(
        h_flex()
          .id(`ph-agy-${pane}`)
          .h(18)
          .px(6)
          .gap(4)
          .flex_none()
          .items_center()
          .rounded(5)
          .border(1)
          .border_color(agyStale ? "#f59e0b66" : t.border)
          .bg(agyStale ? "#f59e0b1a" : t.raised)
          .text_size(10.8)
          .text_color(agyStale ? "#f59e0b" : t.muted)
          .cursor_pointer()
          .tooltip(agyBadgeTip)
          .hover(s => s.bg(agyStale ? "#f59e0b2b" : t.hover).text_color(agyStale ? "#fbbf24" : t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            openOverlay({ mod: "agy-auth", kind: "popup", width: 410, height: 585, at: "pointer" });
          })
          .child(div().size(5).rounded(3).flex_none().bg(agyStale ? "#f59e0b" : "#22c55e"))
          .child(agyAccount)
      ))
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
