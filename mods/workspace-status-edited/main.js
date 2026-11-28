import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, checking, home, openOverlay, shared, setShared } from "herdr";

const hexBin = () =>
  window()?.platform === "windows"
    ? `${home().replace(/[\\/]+$/, "")}\\AppData\\Roaming\\hex\\bin\\hex.com`
    : "hex";

const AGY_CACHE_KEY = "agy-auth.cache";
const AGY_WIN_BIN = "C:\\nvm4w\\nodejs\\node_modules\\@fikrilal\\agy-auth\\npm\\vendor\\agy-auth-win32-x64.exe";

async function execAgyAuth(args) {
  const isWin = window()?.platform === "windows";
  const candidates = isWin ? [AGY_WIN_BIN, "agy-auth.cmd", "agy-auth"] : ["agy-auth"];
  for (const bin of candidates) {
    try {
      return await exec(bin, args, { timeout: 8000 });
    } catch {
      // try next candidate
    }
  }
  return null;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.hexRunning = null; // null: checking, true: running, false: stopped
    this.hexBusy = false;
    if (checking()) return;
    this.pollHex(cx);
    this.pollAgyActive(cx);
    cx.timer.every(5000, (cx) => {
      if (window()?.active) this.pollHex(cx);
    });
    cx.timer.every(15000, (cx) => {
      if (window()?.active) this.pollAgyActive(cx);
    });
  }

  pollAgyActive(cx) {
    if (this.agyPolling) return;
    this.agyPolling = true;
    cx.spawn(async (cx) => {
      try {
        const res = await execAgyAuth(["list", "--no-usage", "--no-sync", "--json"]);
        if (res?.code === 0 && res.stdout) {
          const parsed = JSON.parse(res.stdout);
          const list = parsed?.data?.accounts ?? [];
          const cur = parsed?.data?.current ?? list.find((a) => a.active) ?? null;
          if (cur) {
            const prev = shared(AGY_CACHE_KEY);
            const prevObj = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
            const activeAlias = cur.alias || (cur.email ? cur.email.split("@")[0] : cur.id);
            if (prevObj.activeId !== cur.id || prevObj.activeAlias !== activeAlias || prevObj.activeEmail !== cur.email) {
              const prevById = new Map((prevObj.accounts ?? []).map((a) => [a.id, a]));
              const accounts = list.map((a) => ({ ...prevById.get(a.id), ...a, active: a.id === cur.id }));
              accounts.sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : (a.number ?? 999) - (b.number ?? 999)));
              setShared(AGY_CACHE_KEY, {
                ...prevObj,
                activeId: cur.id ?? null,
                activeEmail: cur.email ?? null,
                activeAlias,
                accounts,
                localUpdatedAt: Date.now(),
              });
              cx.notify();
            }
          }
        }
      } catch {
        // ignore transient local read errors
      } finally {
        this.agyPolling = false;
      }
    });
  }

  pollHex(cx) {
    if (this.hexPolling) return;
    this.hexPolling = true;
    cx.spawn(async (cx) => {
      try {
        const res = await exec(hexBin(), ["status"]);
        const next = res?.code === 0;
        if (next !== this.hexRunning) {
          this.hexRunning = next;
          cx.notify();
        }
      } catch {
        if (this.hexRunning !== false) {
          this.hexRunning = false;
          cx.notify();
        }
      } finally {
        this.hexPolling = false;
      }
    });
  }

  openHex(cx) {
    if (this.hexBusy) return;
    this.hexBusy = true;
    cx.spawn(async (cx) => {
      try {
        const bin = hexBin();
        const show = await exec(bin, ["window", "show"]);
        if (show?.code !== 0) {
          if (window()?.platform === "windows") {
            const lnk = `${home().replace(/[\\/]+$/, "")}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Hex.lnk`;
            await exec("cmd", ["/c", "start", "", lnk]);
          } else {
            await exec(bin, ["start"]);
            await exec(bin, ["window", "show"]);
          }
          await cx.sleep(1500);
        }
      } catch {
        // ignore launch errors; status poll below reflects real state
      } finally {
        this.hexBusy = false;
        this.pollHex(cx);
      }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const hexColor = this.hexRunning === true ? "#22c55e" : this.hexRunning === false ? "#ef4444" : t.dim;
    const hexTip = this.hexRunning === true ? "Hex: running (click to open)" : this.hexRunning === false ? "Hex: stopped (click to start & open)" : "Hex: checking…";
    const agyCache = shared(AGY_CACHE_KEY);
    const agyAlias = agyCache?.activeAlias ?? null;
    const agyEmail = agyCache?.activeEmail ?? null;
    const agyTip = agyAlias
      ? `Antigravity CLI: ${agyAlias}${agyEmail ? ` (${agyEmail})` : ""} — click to view quota & switch`
      : "Antigravity CLI accounts — click to view quota & switch";
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} ${list.length === 1 ? "agent" : "agents"}`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} ${needs === 1 ? "needs" : "need"} you`))))
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .child(
            h_flex()
              .id("hex-status")
              .h(20)
              .px(5)
              .gap(5)
              .rounded(5)
              .items_center()
              .cursor_pointer()
              .tooltip(hexTip)
              .hover(s => s.bg(t.hover))
              .on_click((_e, cx) => this.openHex(cx))
              .child(svg("mods/workspace-status-edited/hex.svg").size(14).flex_none().text_color(hexColor))
          )
          .child(
            h_flex()
              .id("agy-auth-status")
              .h(20)
              .px(6)
              .gap(5)
              .rounded(5)
              .items_center()
              .cursor_pointer()
              .tooltip(agyTip)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => openOverlay({ mod: "agy-auth", kind: "popup", width: 410, height: 585, at: "pointer" }))
              .child(image("icons/antigravity.svg").size(13).flex_none())
              .when(Boolean(agyAlias), el => el.child(div().text_size(11.5).text_color(t.muted).child(agyAlias)))
          )
      )
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
