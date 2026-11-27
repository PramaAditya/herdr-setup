// Herdr Artifact Viewer — Native 60 FPS Multi-Tab Edge WebView2 (PDF, HTML, Localhost & Web)
// with automatic localhost dev-server detection.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import * as fs from "fs/promises";
import {
  appHome,
  checking,
  exec,
  layout,
  nextCommand,
  notify,
  props,
  run,
  setShared,
  settings,
  shared,
  theme,
  window as herdrWindow,
} from "herdr";

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

const DIRECT_FILE_RE = /\.(pdf|html?|mp4|webm|mp3|wav)$/i;

function isDarkTheme(t) {
  const bg = String(t?.background || "").replace("#", "");
  if (bg.length >= 6) {
    const r = parseInt(bg.slice(0, 2), 16);
    const g = parseInt(bg.slice(2, 4), 16);
    const b = parseInt(bg.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  }
  return false;
}

function fileUrlToPath(url) {
  if (!/^file:\/\//i.test(url)) return null;
  try {
    let p = decodeURIComponent(url.replace(/^file:\/+/i, ""));
    if (/^[A-Za-z]:/.test(p)) return p.replace(/\//g, "\\");
    return "/" + p;
  } catch {
    return null;
  }
}

function extractViewPath(url) {
  const m = String(url || "").match(/^https?:\/\/127\.0\.0\.1:\d+\/view\?([^#]*)/i);
  if (!m) return null;
  for (const part of m[1].split("&")) {
    const [k, v] = part.split("=");
    if (k === "path" && v !== undefined) {
      try {
        return decodeURIComponent(v.replace(/\+/g, " "));
      } catch {
        return v;
      }
    }
  }
  return null;
}

function pathToFileUrl(filePath) {
  const norm = String(filePath).replace(/\\/g, "/");
  const encoded = norm
    .split("/")
    .map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p)))
    .join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

function normalizeUrl(raw, port = null, dark = false) {
  const s = String(raw ?? "").trim();
  if (!s) return "about:blank";
  if (/^[A-Za-z]:[\\/]/.test(s)) {
    if (port && !DIRECT_FILE_RE.test(s)) {
      return `http://127.0.0.1:${port}/view?path=${encodeURIComponent(s)}&theme=${dark ? "dark" : "light"}`;
    }
    return pathToFileUrl(s);
  }
  if (/^file:\/\//i.test(s)) {
    const localPath = fileUrlToPath(s);
    if (port && localPath && !DIRECT_FILE_RE.test(localPath)) {
      return `http://127.0.0.1:${port}/view?path=${encodeURIComponent(localPath)}&theme=${dark ? "dark" : "light"}`;
    }
    return s;
  }
  if (/^(https?|about|data):/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

function displayUrl(url) {
  if (!url || url === "about:blank") return "";
  const vp = extractViewPath(url);
  if (vp) return vp;
  return url;
}

function tabLabel(tab) {
  const url = String(tab?.url || "");
  const title = String(tab?.title || "").trim();
  if (!url || url === "about:blank") return "New Tab";

  const vp = extractViewPath(url);
  if (vp) {
    const seg = vp.split(/[\\/]/).pop();
    if (seg) return seg;
  }

  if (/^file:\/\//i.test(url)) {
    try {
      const seg = decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "");
      if (seg) return seg;
    } catch {}
  }

  const localMatch = url.match(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i);
  if (localMatch) {
    const portPart = localMatch[2] || "";
    if (title && title.toLowerCase() !== "localhost") {
      return `${title} (${portPart.slice(1) || "80"})`;
    }
    return `localhost${portPart}`;
  }

  if (title) return title;
  try {
    const m = url.match(/^https?:\/\/([^/?#]+)/i);
    if (m) return m[1];
  } catch {}
  return url;
}

function tabBadge(url) {
  const s = String(url || "");
  const vp = extractViewPath(s);
  const check = vp || s;
  if (/\.pdf([?#].*)?$/i.test(check)) return "PDF";
  if (/\.docx([?#].*)?$/i.test(check)) return "DOCX";
  if (/\.pptx([?#].*)?$/i.test(check)) return "PPTX";
  if (/\.xlsx?([?#].*)?$/i.test(check)) return "XLSX";
  if (/\.csv([?#].*)?$/i.test(check)) return "CSV";
  if (/\.(md|mdx|markdown)([?#].*)?$/i.test(check)) return "MD";
  if (/\.jsonc?([?#].*)?$/i.test(check)) return "JSON";
  if (/\.html?([?#].*)?$/i.test(check)) return "HTML";
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg)([?#].*)?$/i.test(check)) return "IMG";
  if (/\.(txt|log)([?#].*)?$/i.test(check)) return "TXT";
  if (vp) return "FILE";
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(s)) return "DEV";
  return null;
}

export default class ArtifactViewer extends View {
  init(_props, cx) {
    this.isTabMode = props()?.mode === "tab";
    this.port = null;
    this.status = "idle"; // idle | starting | ready | error
    this.error = null;
    this.tabs = [];
    this.activeTab = "";
    this.currentUrl = "";
    this.lastSyncedUrl = "";
    this.viewportW = 460;
    this.viewportH = 690;
    this.exactBounds = null;
    this.lastSentBoundsKey = "";
    this.lastNavTs = Number(shared("browser.navigate")?.ts || 0);
    this.lastFocusUrlTs = Number(shared("browser.focusUrl") || 0);
    this.autoLocalhost = shared("browser.autoLocalhost") !== false;
    this.seenAutoPorts = new Set();
    this._starting = false;

    const rootAbs = appHome().replace(/\\/g, "/");
    this.dataDirAbs = `${rootAbs}/data/browser`;
    this.hostJsonPath = `${this.dataDirAbs}/host.json`;
    this.hostExePath = `${rootAbs}/mods/browser/herdr-webview.exe`;

    this.urlInput = InputState.new({
      placeholder: "Enter localhost:3000, file.md, file.pdf, file.json, or URL...",
    });
    this.urlInput.on("submit", (_e, cx) => {
      const target = this.urlInput.value();
      cx.spawn(async (cx) => {
        await this.navigate(target, false, cx);
      });
    });

    if (checking()) return;

    cx.spawn(async (cx) => {
      let tick = 0;
      for (;;) {
        const visible = this.isPanelVisible();
        // Start host eagerly (hidden) if autoLocalhost is enabled or panel is visible
        if ((visible || this.autoLocalhost) && this.status === "idle" && !this._starting) {
          const pendingNav = shared("browser.navigate");
          await this.ensureHost("about:blank", cx);
          if (this.status === "ready" && (pendingNav?.path || pendingNav?.url)) {
            await this.navigate(pendingNav.path || pendingNav.url, false, cx);
          }
          cx.notify();
        }
        if (this.status === "ready") {
          await this.syncBounds(visible);
          if (visible) {
            await this.post("/ping").catch(() => {});
          }
          const pollEvery = visible ? 3 : 8;
          if (tick % pollEvery === 0) {
            await this.pollStatus(cx);
          }
        }
        tick += 1;
        await cx.sleep(220);
      }
    });

    cx.spawn(async () => {
      for (;;) {
        let cmd;
        try {
          cmd = await nextCommand();
        } catch {
          break;
        }
        if (cmd === "focus") {
          this.urlInput.focus?.();
          cx.notify();
        }
      }
    });
  }

  async close() {
    if (this.port) {
      await this.post("/bounds", { visible: false, width: 0, height: 0 }).catch(() => {});
    }
  }

  isPanelVisible() {
    const w = herdrWindow();
    if (w && w.visible === false) return false;
    if (this.isTabMode) return true;
    const root = layout();
    const panel = findNode(root, "panel");
    const body = findNode(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "browser");
  }

  async post(path, body = null) {
    if (!this.port) return null;
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async getStatus(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async tryReadExistingHost() {
    try {
      const raw = await fs.readFile(this.hostJsonPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.port) {
        const st = await this.getStatus(parsed.port);
        if (st?.ok) return { port: parsed.port, status: st };
      }
    } catch {}
    return null;
  }

  applyStatus(st) {
    if (!st) return false;
    let changed = false;

    if (Array.isArray(st.tabs)) {
      const prevKey = JSON.stringify(this.tabs);
      const nextKey = JSON.stringify(st.tabs);
      if (prevKey !== nextKey) {
        this.tabs = st.tabs;
        changed = true;
      }
    }
    if (st.active_tab && st.active_tab !== this.activeTab) {
      this.activeTab = st.active_tab;
      changed = true;
    }
    const url = st.url || "";
    if (url !== this.lastSyncedUrl) {
      this.currentUrl = url;
      this.lastSyncedUrl = url;
      this.urlInput.set_value(displayUrl(url));
      changed = true;
    }
    return changed;
  }

  async ensureHost(initialUrl = "about:blank", cx = null) {
    if (this._starting) return;
    this._starting = true;
    this.status = "starting";
    this.error = null;

    try {
      const existing = await this.tryReadExistingHost();
      if (existing) {
        this.port = existing.port;
        this.status = "ready";
        this.applyStatus(existing.status);
        this.lastSentBoundsKey = "";
        await this.syncBounds(this.isPanelVisible());
        return;
      }

      const exeWin = this.hostExePath.replace(/\//g, "\\");
      const dataWin = this.dataDirAbs.replace(/\//g, "\\");
      const urlEsc = String(initialUrl || "about:blank").replace(/'/g, "''");
      const ps = `Start-Process -FilePath '${exeWin}' -ArgumentList @('--data-dir','${dataWin}','--url','${urlEsc}')`;
      await exec("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps]);

      for (let i = 0; i < 30; i++) {
        const found = await this.tryReadExistingHost();
        if (found) {
          this.port = found.port;
          this.status = "ready";
          this.applyStatus(found.status);
          this.lastSentBoundsKey = "";
          await this.syncBounds(this.isPanelVisible());
          return;
        }
        if (cx) await cx.sleep(150);
      }
      this.status = "error";
      this.error = "Timed out waiting for WebView2 host to start.";
    } catch (err) {
      this.status = "error";
      this.error = String(err?.message || err || "Failed to start WebView2 host");
    } finally {
      this._starting = false;
    }
  }

  async syncBounds(visible) {
    if (!this.port) return;
    const zoom = Number(settings()?.zoom || 1);
    const payload = visible
      ? {
          visible: true,
          x: this.exactBounds ? this.exactBounds.x : null,
          y: this.exactBounds ? this.exactBounds.y : null,
          right_margin: this.exactBounds ? null : 9,
          top_margin: this.exactBounds ? null : 119,
          width: Math.max(100, this.exactBounds?.width ?? this.viewportW),
          height: Math.max(100, this.exactBounds?.height ?? this.viewportH),
          zoom,
        }
      : { visible: false, width: 0, height: 0, zoom };

    const key = JSON.stringify(payload);
    if (key === this.lastSentBoundsKey) return;
    this.lastSentBoundsKey = key;
    try {
      await this.post("/bounds", payload);
    } catch {
      this.status = "idle";
      this.port = null;
      this.lastSentBoundsKey = "";
    }
  }

  async pollStatus(cx) {
    if (!this.port) return;
    const st = await this.getStatus(this.port);
    if (!st?.ok) {
      this.status = "idle";
      this.port = null;
      this.lastSentBoundsKey = "";
      cx.notify();
      return;
    }

    const changed = this.applyStatus(st);

    // Auto-intercept newly detected localhost HTTP servers
    const newPorts = Array.isArray(st.new_ports) ? st.new_ports : [];
    const liveSet = new Set(newPorts);
    for (const p of [...this.seenAutoPorts]) {
      if (!liveSet.has(p)) this.seenAutoPorts.delete(p);
    }

    for (const p of newPorts) {
      if (this.seenAutoPorts.has(p)) continue;
      this.seenAutoPorts.add(p);
      if (this.autoLocalhost) {
        const url = `http://localhost:${p}/`;
        await this.post("/tabs/open", { url, dedupe: true });
        run("layout.select", { stack: "panel-body", child: "browser" });
        run("layout.show", { id: "panel" });
        this.lastSentBoundsKey = "";
        await this.syncBounds(true);
        notify({
          title: "Artifact Viewer",
          body: `Detected localhost:${p} — opened in new tab`,
          level: "info",
        });
        const st2 = await this.getStatus(this.port);
        if (st2?.ok) this.applyStatus(st2);
        cx.notify();
        return;
      }
    }

    if (changed) cx.notify();
  }

  async navigate(urlOrPath, newTab = false, cx = null) {
    if (!this.port) {
      await this.ensureHost("about:blank", cx);
    }
    if (this.port) {
      const norm = normalizeUrl(urlOrPath, this.port, isDarkTheme(theme()));
      if (newTab) {
        await this.post("/tabs/open", { url: norm, dedupe: true });
      } else {
        this.currentUrl = norm;
        this.lastSyncedUrl = norm;
        this.urlInput.set_value(displayUrl(norm));
        await this.post("/navigate", { url: norm });
      }
      this.lastSentBoundsKey = "";
      await this.syncBounds(this.isPanelVisible());
      const st = await this.getStatus(this.port);
      if (st?.ok) this.applyStatus(st);
      if (cx) cx.notify();
    }
  }

  async openBlankTab(cx) {
    if (!this.port) {
      await this.ensureHost("about:blank", cx);
    }
    if (this.port) {
      await this.post("/tabs/open", { url: "about:blank", dedupe: false });
      const st = await this.getStatus(this.port);
      if (st?.ok) this.applyStatus(st);
      this.urlInput.set_value("");
      this.urlInput.focus?.();
      this.lastSentBoundsKey = "";
      await this.syncBounds(this.isPanelVisible());
      cx.notify();
    }
  }

  async selectTab(id, cx) {
    if (!this.port || !id) return;
    await this.post("/tabs/select", { id });
    const st = await this.getStatus(this.port);
    if (st?.ok) this.applyStatus(st);
    this.lastSentBoundsKey = "";
    await this.syncBounds(this.isPanelVisible());
    cx.notify();
  }

  async closeTab(id, cx) {
    if (!this.port || !id) return;
    const isLastTab = this.tabs.length <= 1;
    await this.post("/tabs/close", { id });
    if (isLastTab) {
      await this.syncBounds(false);
      run("layout.hide", { id: "panel" });
    }
    const st = await this.getStatus(this.port);
    if (st?.ok) this.applyStatus(st);
    if (!isLastTab) {
      this.lastSentBoundsKey = "";
      await this.syncBounds(this.isPanelVisible());
    }
    cx.notify();
  }

  toggleAutoLocalhost(cx) {
    this.autoLocalhost = !this.autoLocalhost;
    setShared("browser.autoLocalhost", this.autoLocalhost);
    cx.notify();
  }

  renderTabBar(t, cx) {
    const stop = (_e, cx) => cx.stop_propagation();
    const tabs = this.tabs.length > 0 ? this.tabs : [{ id: "tab-1", url: this.currentUrl, title: "" }];

    return h_flex()
      .w_full()
      .h(32)
      .px(6)
      .gap(4)
      .items_center()
      .flex_none()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .gap(3)
          .overflow_hidden()
          .children(
            tabs.map((tab, idx) => {
              const active = tab.id === this.activeTab || (tabs.length === 1 && idx === 0);
              const badge = tabBadge(tab.url);
              const label = tabLabel(tab);
              const shortLabel = label.length > 22 ? `${label.slice(0, 21)}…` : label;

              return h_flex()
                .id(`av-tab-${tab.id}`)
                .h(24)
                .px(7)
                .gap(5)
                .items_center()
                .rounded(6)
                .bg(active ? t.selected : t.chrome)
                .text_color(active ? t.foreground : t.muted)
                .hover((s) => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => cx.spawn((cx) => this.selectTab(tab.id, cx)))
                .when(Boolean(badge), (el) =>
                  el.child(
                    div()
                      .px(4)
                      .py(1)
                      .rounded(4)
                      .text_size(9)
                      .font_semibold()
                      .bg(badge === "DEV" ? t.accent : t.raised)
                      .text_color(badge === "DEV" ? t.accent_foreground : t.muted)
                      .child(badge)
                  )
                )
                .child(div().text_size(11).child(shortLabel))
                .child(
                  div()
                    .id(`av-close-${tab.id}`)
                    .px(3)
                    .rounded(4)
                    .text_size(11)
                    .text_color(t.dim)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      cx.spawn((cx) => this.closeTab(tab.id, cx));
                    })
                    .child("×")
                );
            })
          )
      )
      .child(
        div()
          .id("av-new-tab")
          .h(24)
          .w(24)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(6)
          .text_size(13)
          .bg(t.chrome)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => cx.spawn((cx) => this.openBlankTab(cx)))
          .child("+")
      );
  }

  renderToolbar(t, cx) {
    const stop = (_e, cx) => cx.stop_propagation();
    const ready = this.status === "ready";
    const iconBtn = (id, label, onClick, disabled = false) =>
      div()
        .id(id)
        .h(26)
        .px(7)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_size(12)
        .bg(t.chrome)
        .text_color(disabled ? t.dim : t.muted)
        .when(!disabled, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_mouse_down("left", stop)
        .when(!disabled, (el) => el.on_click(onClick))
        .child(label);

    return h_flex()
      .w_full()
      .h(36)
      .px(6)
      .gap(4)
      .items_center()
      .flex_none()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(iconBtn("br-back", "←", () => cx.spawn(() => this.post("/back")), !ready))
      .child(iconBtn("br-fwd", "→", () => cx.spawn(() => this.post("/forward")), !ready))
      .child(
        iconBtn(
          "br-reload",
          "↻",
          (_e, cx) =>
            cx.spawn(async (cx) => {
              if (this.currentUrl && /^file:\/\//i.test(this.currentUrl)) {
                const upgraded = normalizeUrl(this.currentUrl, this.port, isDarkTheme(theme()));
                if (upgraded !== this.currentUrl) {
                  await this.navigate(this.currentUrl, false, cx);
                  return;
                }
              }
              await this.post("/reload");
            }),
          !ready
        )
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .on_mouse_down("left", stop)
          .child(Input.new(this.urlInput).h(26).text_size(12))
      )
      .child(
        h_flex()
          .id("br-auto")
          .h(24)
          .px(7)
          .gap(4)
          .flex_none()
          .items_center()
          .rounded(6)
          .text_size(11)
          .bg(this.autoLocalhost ? t.selected : t.chrome)
          .text_color(this.autoLocalhost ? t.foreground : t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => this.toggleAutoLocalhost(cx))
          .child(
            div()
              .size(6)
              .rounded(99)
              .bg(this.autoLocalhost ? t.working : t.dim)
          )
          .child("Auto")
      )
      .child(iconBtn("br-devtools", "DevTools", () => cx.spawn(() => this.post("/devtools")), !ready))
      .child(
        iconBtn(
          "br-ext",
          "↗",
          (_e, cx) => {
            if (this.currentUrl && /^https?:\/\//i.test(this.currentUrl)) {
              cx.open_url(this.currentUrl);
            }
          },
          !this.currentUrl || !/^https?:\/\//i.test(this.currentUrl)
        )
      );
  }

  render(cx) {
    const t = theme();

    const navReq = shared("browser.navigate");
    if ((navReq?.path || navReq?.url) && Number(navReq.ts) > this.lastNavTs) {
      this.lastNavTs = Number(navReq.ts);
      if (!checking()) {
        cx.spawn(async (cx) => {
          await this.navigate(navReq.path || navReq.url, Boolean(navReq.newTab), cx);
        });
      }
    }

    const focusReq = Number(shared("browser.focusUrl") || 0);
    if (focusReq > this.lastFocusUrlTs) {
      this.lastFocusUrlTs = focusReq;
      this.urlInput.focus?.();
    }

    return v_flex()
      .size_full()
      .min_w(0)
      .min_h(0)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .overflow_hidden()
      .child(this.renderTabBar(t, cx))
      .child(this.renderToolbar(t, cx))
      .child(
        div()
          .id("browser-viewport")
          .flex_1()
          .w_full()
          .min_h(0)
          .bg(t.background)
          .flex()
          .items_center()
          .justify_center()
          .on_size_change((size, cx) => {
            if (Math.abs(size.width - this.viewportW) > 1 || Math.abs(size.height - this.viewportH) > 1) {
              this.viewportW = size.width;
              this.viewportH = size.height;
              if (this.exactBounds) {
                this.exactBounds = { ...this.exactBounds, width: size.width, height: size.height };
              }
              this.lastSentBoundsKey = "";
              if (this.status === "ready") {
                cx.spawn(async () => { await this.syncBounds(this.isPanelVisible()); });
              }
            }
          })
          .on_window_mouse_move((e, cx) => {
            if (e?.bounds && e.bounds.width > 50 && e.bounds.height > 50) {
              const prev = this.exactBounds;
              if (
                !prev ||
                Math.abs(prev.x - e.bounds.x) > 1 ||
                Math.abs(prev.y - e.bounds.y) > 1 ||
                Math.abs(prev.width - e.bounds.width) > 1 ||
                Math.abs(prev.height - e.bounds.height) > 1
              ) {
                this.exactBounds = {
                  x: e.bounds.x,
                  y: e.bounds.y,
                  width: e.bounds.width,
                  height: e.bounds.height,
                };
                this.lastSentBoundsKey = "";
                if (this.status === "ready") {
                  cx.spawn(async () => { await this.syncBounds(this.isPanelVisible()); });
                }
              }
            }
          })
          .when(this.status !== "ready", (el) =>
            el.child(
              v_flex()
                .items_center()
                .justify_center()
                .gap(8)
                .p(20)
                .child(svg("mods/browser/globe.svg").size(26).text_color(t.muted))
                .child(
                  div()
                    .text_size(13)
                    .font_semibold()
                    .text_color(t.foreground)
                    .child(this.status === "error" ? "Artifact Viewer Error" : "Starting Artifact Viewer…")
                )
                .when(Boolean(this.error), (e2) =>
                  e2.child(div().text_size(12).text_color(t.muted).child(this.error))
                )
                .when(this.status === "error", (e2) =>
                  e2.child(
                    div()
                      .id("br-retry")
                      .px(12)
                      .py(6)
                      .rounded(7)
                      .text_size(12)
                      .bg(t.solid)
                      .text_color(t.solid_foreground)
                      .on_click((_e, cx) => {
                        this.status = "idle";
                        cx.spawn(async (cx) => { await this.ensureHost(this.currentUrl || "about:blank", cx); cx.notify(); });
                      })
                      .child("Retry")
                  )
                )
            )
          )
      );
  }
}
