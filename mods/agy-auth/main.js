import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, closeOverlay, exec, notify, props, setShared, shared, theme, window } from "herdr";

const CACHE_KEY = "agy-auth.cache";
const NATIVE_WIN_BIN = "C:\\nvm4w\\nodejs\\node_modules\\@fikrilal\\agy-auth\\npm\\vendor\\agy-auth-win32-x64.exe";

async function runAgyAuth(args, timeout = 25000) {
  const isWin = window()?.platform === "windows";
  const candidates = isWin ? [NATIVE_WIN_BIN, "agy-auth.cmd", "agy-auth"] : ["agy-auth"];
  let lastErr = null;
  for (const bin of candidates) {
    try {
      return await exec(bin, args, { timeout });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("agy-auth binary not found");
}

function parseJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readCache() {
  const raw = shared(CACHE_KEY);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function formatReset(iso) {
  if (!iso) return "";
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "now";
  const mins = Math.ceil(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return remM > 0 ? `${hrs}h ${remM}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

function formatAge(ts) {
  if (!ts) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function pctColor(pct, t) {
  if (pct == null || Number.isNaN(pct)) return t.dim;
  if (pct >= 50) return "#22c55e";
  if (pct >= 20) return "#f59e0b";
  return "#ef4444";
}

function shortGroupName(name) {
  const s = String(name ?? "");
  if (/gemini/i.test(s)) return "Gemini";
  if (/claude|gpt/i.test(s)) return "Claude & GPT";
  return s || "Quota";
}

function findBucket(group, win) {
  return (group?.buckets ?? []).find((b) => b.window === win) ?? null;
}

function getPrimaryQuotas(acct) {
  const groups = acct?.groups ?? [];
  const primary = groups.find((g) => /gemini/i.test(g.name)) ?? groups[0] ?? null;
  if (!primary) return null;
  const fiveH = findBucket(primary, "5h")?.remaining_percent ?? null;
  const weekly = findBucket(primary, "weekly")?.remaining_percent ?? null;
  if (fiveH == null && weekly == null) return null;
  return {
    fiveH: fiveH ?? weekly ?? 0,
    weekly: weekly ?? fiveH ?? 0,
  };
}

function healthScore(acct) {
  const q = getPrimaryQuotas(acct);
  if (!q) return -1;
  const bottleneck = Math.min(q.fiveH, q.weekly);
  if (bottleneck <= 0) return 0;
  const avg = (q.fiveH + q.weekly) / 2;
  return 0.6 * bottleneck + 0.4 * avg;
}

function accountLabel(acct) {
  return acct?.alias || (acct?.email ? acct.email.split("@")[0] : acct?.id || "Account");
}

function mergeAccounts(baseList, quotaList, currentObj) {
  const activeId = currentObj?.id ?? baseList.find((a) => a.active)?.id ?? null;
  const activeEmail = (currentObj?.email ?? baseList.find((a) => a.active)?.email ?? "").toLowerCase();
  const quotaById = new Map((quotaList ?? []).map((a) => [a.id, a]));
  const prevById = new Map((readCache().accounts ?? []).map((a) => [a.id, a]));

  const merged = (baseList ?? []).map((acct) => {
    const q = quotaById.get(acct.id);
    const prev = prevById.get(acct.id);
    const isActive = activeId
      ? acct.id === activeId
      : Boolean(activeEmail && String(acct.email ?? "").toLowerCase() === activeEmail);
    return {
      ...prev,
      ...acct,
      active: isActive,
      plan: acct.plan ?? prev?.plan ?? null,
      groups: q?.groups ?? prev?.groups ?? null,
      quotaUpdatedAt: q?.updated_at ?? prev?.quotaUpdatedAt ?? null,
    };
  });

  // Keep active account at the top, preserve original order for the rest.
  merged.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (a.number ?? 999) - (b.number ?? 999);
  });

  const activeAcct = merged.find((a) => a.active) ?? currentObj ?? null;
  return {
    activeId: activeAcct?.id ?? null,
    activeEmail: activeAcct?.email ?? null,
    activeAlias: activeAcct ? accountLabel(activeAcct) : null,
    accounts: merged,
  };
}

export default class AgyAuthPopover extends View {
  init(_props, cx) {
    this.loadingLocal = false;
    this.loadingQuota = false;
    this.switchingId = null;
    this.rotating = false;
    this.error = null;

    if (checking()) return;
    this.refresh(cx, true);
  }

  refresh(cx, fetchQuota = true) {
    if (this.loadingLocal || this.loadingQuota) return;
    this.error = null;
    this.loadingLocal = true;
    cx.notify();

    cx.spawn(async (cx) => {
      let baseAccounts = readCache().accounts ?? [];
      let currentObj = null;

      // Stage 1: instant local keyring + registry read (~60ms)
      try {
        const res = await runAgyAuth(["list", "--no-usage", "--no-sync", "--json"], 10000);
        const parsed = parseJson(res?.stdout);
        if (res?.code === 0 && parsed?.data?.accounts) {
          baseAccounts = parsed.data.accounts;
          currentObj = parsed.data.current ?? null;
          const prev = readCache();
          const merged = mergeAccounts(baseAccounts, null, currentObj);
          setShared(CACHE_KEY, {
            ...prev,
            ...merged,
            localUpdatedAt: Date.now(),
          });
        } else {
          this.error = (res?.stderr || res?.stdout || "Failed to read agy-auth accounts").trim();
        }
      } catch (err) {
        this.error = String(err?.message ?? err);
      } finally {
        this.loadingLocal = false;
        cx.notify();
      }

      if (!fetchQuota || this.error) return;

      // Stage 2: on-demand live quota fetch across all stored accounts
      this.loadingQuota = true;
      cx.notify();
      try {
        const res = await runAgyAuth(["list", "--all", "--no-sync", "--json"], 25000);
        const parsed = parseJson(res?.stdout);
        if (res?.code === 0 && parsed?.data?.accounts) {
          const prev = readCache();
          const curNow = prev.activeId
            ? { id: prev.activeId, email: prev.activeEmail, alias: prev.activeAlias }
            : currentObj;
          const merged = mergeAccounts(prev.accounts?.length ? prev.accounts : baseAccounts, parsed.data.accounts, curNow);
          setShared(CACHE_KEY, {
            ...prev,
            ...merged,
            quotaUpdatedAt: Date.now(),
          });
        } else if (res?.stderr) {
          this.error = res.stderr.trim();
        }
      } catch (err) {
        this.error = String(err?.message ?? err);
      } finally {
        this.loadingQuota = false;
        cx.notify();
      }
    });
  }

  switchTo(acct, cx) {
    if (!acct?.id || this.switchingId || this.rotating) return;
    this.switchingId = acct.id;
    this.error = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await runAgyAuth(["switch", acct.id, "--target=cli", "--json"], 15000);
        if (res?.code !== 0) {
          const msg = (res?.stderr || res?.stdout || "Switch failed").trim();
          this.error = msg;
          notify({ title: "agy-auth switch failed", body: msg, level: "error", timeout: 5000 });
        } else {
          const prev = readCache();
          const updated = mergeAccounts(
            (prev.accounts ?? []).map((a) => ({ ...a, active: a.id === acct.id })),
            null,
            { id: acct.id, email: acct.email, alias: acct.alias }
          );
          setShared(CACHE_KEY, { ...prev, ...updated, localUpdatedAt: Date.now() });
          notify({
            title: `Switched CLI to ${accountLabel(acct)}`,
            body: `${acct.email} · Restart running agy sessions to apply`,
            level: "success",
            timeout: 4500,
          });
        }
      } catch (err) {
        const msg = String(err?.message ?? err);
        this.error = msg;
        notify({ title: "agy-auth switch failed", body: msg, level: "error", timeout: 5000 });
      } finally {
        this.switchingId = null;
        cx.notify();
        this.refresh(cx, false);
      }
    });
  }

  rotateAccount(cx) {
    if (this.switchingId || this.rotating) return;
    this.rotating = true;
    this.error = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        // Ensure we have fresh local + quota data before scoring
        let cache = readCache();
        const quotaStale = !cache.quotaUpdatedAt || Date.now() - cache.quotaUpdatedAt > 60000;
        const missingQuota = !(cache.accounts ?? []).some((a) => Array.isArray(a.groups) && a.groups.length > 0);
        if (quotaStale || missingQuota) {
          const [localRes, quotaRes] = await Promise.all([
            runAgyAuth(["list", "--no-usage", "--no-sync", "--json"], 10000),
            runAgyAuth(["list", "--all", "--no-sync", "--json"], 25000),
          ]);
          const localParsed = parseJson(localRes?.stdout);
          const quotaParsed = parseJson(quotaRes?.stdout);
          if (localRes?.code === 0 && localParsed?.data?.accounts && quotaRes?.code === 0 && quotaParsed?.data?.accounts) {
            const merged = mergeAccounts(localParsed.data.accounts, quotaParsed.data.accounts, localParsed.data.current ?? null);
            cache = { ...cache, ...merged, localUpdatedAt: Date.now(), quotaUpdatedAt: Date.now() };
            setShared(CACHE_KEY, cache);
            cx.notify();
          }
        }

        const ranked = [...(cache.accounts ?? [])]
          .map((acct) => ({ acct, score: healthScore(acct), q: getPrimaryQuotas(acct) }))
          .filter((x) => x.score >= 0)
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if ((b.q?.weekly ?? 0) !== (a.q?.weekly ?? 0)) return (b.q?.weekly ?? 0) - (a.q?.weekly ?? 0);
            return (b.q?.fiveH ?? 0) - (a.q?.fiveH ?? 0);
          });

        const best = ranked[0];
        if (!best || best.score <= 0) {
          notify({
            title: "No healthy account available",
            body: "All stored accounts have exhausted 5h or weekly Gemini quota",
            level: "warning",
            timeout: 4500,
          });
          return;
        }

        if (best.acct.active) {
          notify({
            title: `Already on healthiest account (${accountLabel(best.acct)})`,
            body: `Gemini 5h ${best.q.fiveH}% · Weekly ${best.q.weekly}%`,
            level: "info",
            timeout: 4000,
          });
          return;
        }

        const res = await runAgyAuth(["switch", best.acct.id, "--target=cli", "--json"], 15000);
        if (res?.code !== 0) {
          const msg = (res?.stderr || res?.stdout || "Switch failed").trim();
          this.error = msg;
          notify({ title: "agy-auth rotate failed", body: msg, level: "error", timeout: 5000 });
        } else {
          const prev = readCache();
          const updated = mergeAccounts(
            (prev.accounts ?? []).map((a) => ({ ...a, active: a.id === best.acct.id })),
            null,
            { id: best.acct.id, email: best.acct.email, alias: best.acct.alias }
          );
          setShared(CACHE_KEY, { ...prev, ...updated, localUpdatedAt: Date.now() });
          notify({
            title: `Switched CLI to ${accountLabel(best.acct)}`,
            body: `Gemini 5h ${best.q.fiveH}% · Weekly ${best.q.weekly}% · Restart active agy to apply`,
            level: "success",
            timeout: 4500,
          });
        }
      } catch (err) {
        const msg = String(err?.message ?? err);
        this.error = msg;
        notify({ title: "agy-auth rotate failed", body: msg, level: "error", timeout: 5000 });
      } finally {
        this.rotating = false;
        cx.notify();
      }
    });
  }

  renderBar(label, bucket, t, trackW) {
    const pct = bucket?.remaining_percent;
    const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    const fillW = clamped > 0 ? Math.max(4, Math.round((clamped / 100) * trackW)) : 0;
    const color = pctColor(pct, t);
    const reset = formatReset(bucket?.reset_time);

    return v_flex()
      .flex_1()
      .min_w(0)
      .gap(4)
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .text_size(11)
          .child(div().text_color(t.muted).child(label))
          .child(div().font_semibold().text_color(color).child(pct == null ? "—" : `${pct}%`))
          .child(div().flex_1())
          .when(Boolean(reset), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(reset)))
      )
      .child(
        h_flex()
          .w_full()
          .h(4)
          .rounded(2)
          .bg(t.border)
          .overflow_hidden()
          .when(fillW > 0, (el) => el.child(div().h_full().w(fillW).rounded(2).bg(color)))
      );
  }

  renderAccount(acct, t) {
    const isActive = Boolean(acct.active);
    const isSwitching = this.switchingId === acct.id;
    const busy = Boolean(this.switchingId || this.rotating);
    const groups = acct.groups ?? [];
    const primary = groups.find((g) => /gemini/i.test(g.name)) ?? groups[0] ?? null;
    const others = groups.filter((g) => g !== primary);

    const fiveH = primary ? findBucket(primary, "5h") : null;
    const weekly = primary ? findBucket(primary, "weekly") : null;

    const trackW = Math.max(60, Math.floor(((this.rootW || 410) - 56) / 2));

    return v_flex()
      .id(`acct-${acct.id}`)
      .p(10)
      .gap(8)
      .rounded(8)
      .border(1)
      .border_color(isActive ? t.accent : t.border)
      .bg(isActive ? t.raised : t.surface)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .size(7)
              .rounded(4)
              .flex_none()
              .bg(isActive ? "#22c55e" : t.dim)
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(1)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().font_semibold().text_size(12.8).text_color(t.foreground).truncate().child(accountLabel(acct)))
                  .when(Boolean(acct.plan), (el) =>
                    el.child(
                      div()
                        .px(5)
                        .py(1)
                        .rounded(4)
                        .bg(t.hover)
                        .text_size(10)
                        .text_color(t.muted)
                        .flex_none()
                        .child(acct.plan)
                    )
                  )
              )
              .child(div().text_size(11).text_color(t.dim).truncate().child(acct.email ?? acct.id))
          )
          .when(isActive, (el) =>
            el.child(
              h_flex()
                .h(24)
                .px(8)
                .gap(4)
                .rounded(6)
                .flex_none()
                .items_center()
                .bg(t.selected)
                .text_size(11)
                .font_semibold()
                .text_color("#22c55e")
                .child(svg("mods/workspace-chrome/check.svg").size(12).text_color("#22c55e"))
                .child("Active")
            )
          )
          .when(!isActive, (el) =>
            el.child(
              h_flex()
                .id(`switch-${acct.id}`)
                .h(24)
                .px(9)
                .gap(5)
                .rounded(6)
                .flex_none()
                .items_center()
                .border(1)
                .border_color(t.border)
                .bg(t.raised)
                .text_size(11.5)
                .text_color(busy ? t.dim : t.foreground)
                .when(!busy, (b) => b.cursor_pointer().hover((s) => s.bg(t.hover).border_color(t.accent)))
                .on_click((_e, cx) => {
                  if (!busy) this.switchTo(acct, cx);
                })
                .when(isSwitching, (b) => b.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.accent).spin(900)))
                .child(isSwitching ? "Switching…" : "Switch")
            )
          )
      )
      .when(Boolean(primary), (el) =>
        el.child(
          v_flex()
            .gap(6)
            .child(
              h_flex()
                .gap(12)
                .items_center()
                .child(this.renderBar(`${shortGroupName(primary.name)} 5h`, fiveH, t, trackW))
                .child(this.renderBar("Weekly", weekly, t, trackW))
            )
            .when(others.length > 0, (wrap) =>
              wrap.child(
                h_flex()
                  .gap(10)
                  .items_center()
                  .text_size(10.8)
                  .children(
                    others.map((g, idx) => {
                      const b5 = findBucket(g, "5h");
                      const bw = findBucket(g, "weekly");
                      const p5 = b5?.remaining_percent;
                      const pw = bw?.remaining_percent;
                      return h_flex()
                        .id(`other-${acct.id}-${idx}`)
                        .gap(5)
                        .items_center()
                        .child(div().text_color(t.dim).child(`${shortGroupName(g.name)}:`))
                        .child(div().text_color(pctColor(p5, t)).child(`5h ${p5 ?? "—"}%`))
                        .child(div().text_color(t.dim).child("·"))
                        .child(div().text_color(pctColor(pw, t)).child(`Wk ${pw ?? "—"}%`));
                    })
                  )
              )
            )
        )
      )
      .when(!primary && this.loadingQuota, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child("Fetching quota…"))
      );
  }

  render() {
    const t = theme();
    const cache = readCache();
    const accounts = cache.accounts ?? [];
    const busy = this.loadingLocal || this.loadingQuota || Boolean(this.switchingId) || this.rotating;

    const iconBtn = (id, iconPath, tip, disabled, action) =>
      div()
        .id(id)
        .size(24)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_color(disabled ? t.dim : t.muted)
        .tooltip(tip)
        .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => {
          if (!disabled) action(cx);
        })
        .child(svg(iconPath).size(13));

    const hasQuota = accounts.some((a) => Array.isArray(a.groups) && a.groups.length > 0);
    const cardH = hasQuota ? 114 : 72;
    const listH = accounts.length > 0
      ? accounts.length * cardH + Math.max(0, accounts.length - 1) * 8 + 20
      : 60;
    const rootH = Math.min(565, Math.max(140, 40 + 28 + (this.error ? 32 : 0) + listH));

    return v_flex()
      .id("agy-auth-root")
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - (this.rootW ?? 0)) > 2) {
          this.rootW = size.width;
          cx.notify();
        }
      })
      .w_full()
      .h(rootH)
      .min_h(0)
      .bg(t.popover)
      .text_size(12.5)
      .text_color(t.foreground)
      .overflow_hidden()
      .child(
        h_flex()
          .h(40)
          .px(12)
          .gap(7)
          .flex_none()
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(image("icons/antigravity.svg").size(15).flex_none())
          .child(div().font_semibold().text_size(13).child("Antigravity CLI"))
          .when(accounts.length > 0, (el) =>
            el.child(
              div()
                .px(5)
                .py(1)
                .rounded(4)
                .bg(t.raised)
                .text_size(10.5)
                .text_color(t.muted)
                .child(String(accounts.length))
            )
          )
          .child(div().flex_1())
          .when(this.loadingQuota || this.rotating, (el) =>
            el.child(
              h_flex()
                .gap(5)
                .items_center()
                .text_size(11)
                .text_color(t.dim)
                .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.accent).spin(900))
                .child(this.rotating ? "Rotating…" : "Quota…")
            )
          )
          .child(iconBtn("agy-rotate", "mods/agy-auth/rotate.svg", "Rotate to healthiest account (CLI)", busy || accounts.length < 2, (cx) => this.rotateAccount(cx)))
          .child(iconBtn("agy-refresh", "mods/agy-auth/refresh.svg", "Refresh quota", busy, (cx) => this.refresh(cx, true)))
          .child(iconBtn("agy-close", "mods/workspace-chrome/x.svg", "Close", false, () => closeOverlay(props()?.overlay)))
      )
      .when(Boolean(this.error), (el) =>
        el.child(
          div()
            .px(12)
            .py(7)
            .bg(t.surface)
            .border_b(1)
            .border_color(t.blocked)
            .text_size(11.5)
            .text_color(t.blocked)
            .child(this.error)
        )
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .p(10)
          .gap(8)
          .overflow_y_scrollbar()
          .when(accounts.length === 0 && !this.loadingLocal, (el) =>
            el.child(
              div()
                .p(16)
                .text_color(t.dim)
                .child("No stored accounts found. Run `agy-auth login` or `agy-auth add` in a terminal.")
            )
          )
          .when(accounts.length === 0 && this.loadingLocal, (el) =>
            el.child(
              h_flex()
                .p(16)
                .gap(8)
                .items_center()
                .text_color(t.dim)
                .child(svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.accent).spin(900))
                .child("Reading agy-auth accounts…")
            )
          )
          .children(accounts.map((acct) => this.renderAccount(acct, t)))
      )
      .child(
        h_flex()
          .h(28)
          .px(12)
          .gap(8)
          .flex_none()
          .items_center()
          .bg(t.surface)
          .border_t(1)
          .border_color(t.border)
          .text_size(10.8)
          .text_color(t.dim)
          .child("CLI target · restart active agy to apply")
          .child(div().flex_1())
          .when(Boolean(cache.quotaUpdatedAt), (el) => el.child(`Updated ${formatAge(cache.quotaUpdatedAt)}`))
      );
  }
}
