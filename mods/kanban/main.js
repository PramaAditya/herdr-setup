// Read-only .kanban/ board viewer for the focused pane's project folder.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, run, theme, window } from "herdr";

const STATUS_ORDER = [
  { id: "in_progress", label: "In Progress", color: "working" },
  { id: "blocked", label: "Blocked", color: "blocked" },
  { id: "todo", label: "Todo", color: "accent" },
  { id: "idea", label: "Idea", color: "muted" },
  { id: "done", label: "Done", color: "done" },
];

const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };
function currentLocation(prev) {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (!pane?.cwd && !f?.cwd && prev && prev.space === space?.id && prev.cwd) {
    return { cwd: prev.cwd, on: prev.on, space: prev.space };
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on, space: space?.id ?? null };
}

function parseCard(filename, fullPath, raw) {
  let title = filename.replace(/\.md$/i, "");
  let status = "todo";
  let priority = "medium";
  const tags = [];

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;

  if (fmMatch) {
    const lines = fmMatch[1].split(/\r?\n/);
    let inTags = false;
    for (const line of lines) {
      if (inTags) {
        const tagMatch = /^\s*-\s+(.+?)\s*$/.exec(line);
        if (tagMatch) {
          tags.push(tagMatch[1].replace(/^["']|["']$/g, ""));
          continue;
        }
        if (/^\S/.test(line)) inTags = false;
      }
      const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].trim();
      const val = kv[2].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
      if (key === "title" && val) title = val;
      else if (key === "status" && val) status = val.toLowerCase();
      else if (key === "priority" && val) priority = val.toLowerCase();
      else if (key === "tags") inTags = true;
    }
  }

  let checked = 0;
  let total = 0;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*-\s+\[[xX]\]\s+/.test(line)) {
      checked++;
      total++;
    } else if (/^\s*-\s+\[\s\]\s+/.test(line)) {
      total++;
    }
  }

  return { filename, fullPath, title, status, priority, tags, checked, total };
}

export default class Kanban extends View {
  init(_props, cx) {
    this.loc = null;
    this.cards = [];
    this.loading = false;
    this.error = null;
    this.collapsedGroups = new Set(["done"]);
    cx.timer.every(5000, (cx) => this.load(cx, true));
  }

  load(cx, silent = false) {
    const loc = currentLocation(this.loc);
    const { cwd, on } = loc;
    this.loc = loc;
    if (!cwd) {
      this.cards = [];
      this.loading = false;
      this.error = null;
      return;
    }
    if (!silent) {
      this.loading = true;
      this.error = null;
    }
    const base = cwd.replace(/[\\/]+$/, "");
    const isWin = !on && window()?.platform === "windows";
    cx.spawn(async (cx) => {
      try {
        const res = isWin
          ? await exec("cmd", ["/c", 'dir /b /a-d ".kanban\\*.md"'], { cwd, on })
          : await exec("ls", ["-1", ".kanban"], { cwd, on });
        if (res?.code !== 0) {
          if (this.loc?.cwd !== cwd) return;
          this.cards = [];
          this.error = "No .kanban/ folder in this project";
          return;
        }
        const mdFiles = res.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((f) => f.endsWith(".md"))
          .sort();
        const parsed = [];
        for (const f of mdFiles) {
          const fullPath = `${base}/.kanban/${f}`;
          try {
            const raw = await readTextFile(fullPath, { on });
            if (raw !== null) parsed.push(parseCard(f, fullPath, raw));
          } catch {
            // skip unreadable card
          }
        }
        if (this.loc?.cwd !== cwd) return;
        this.cards = parsed;
        this.error = null;
      } catch {
        if (this.loc?.cwd !== cwd) return;
        this.cards = [];
        this.error = "No .kanban/ folder in this project";
      } finally {
        if (this.loc?.cwd === cwd) this.loading = false;
        cx.notify();
      }
    });
  }

  openCard(card) {
    const space = spaces().find((s) => s.active);
    const existing = space?.tabs.find(
      (t) => t.named && t.name === card.filename && panes().some((p) => p.tab === t.id && !p.terminal)
    );
    if (existing) {
      run("tab.select", { id: existing.id });
      return;
    }
    run("tab.new", {
      name: card.filename,
      space: space?.id,
      mod: "file-viewer",
      props: { path: card.fullPath, label: `.kanban/${card.filename}`, on: this.loc?.on ?? null },
    });
  }

  render(cx) {
    const nextLoc = currentLocation(this.loc);
    if (nextLoc.cwd !== this.loc?.cwd || nextLoc.space !== this.loc?.space) {
      this.load(cx, false);
    }

    const t = theme();
    const projectName = this.loc?.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "";
    const byStatus = new Map(STATUS_ORDER.map((s) => [s.id, []]));
    for (const card of this.cards) {
      const bucket = byStatus.get(card.status) ?? byStatus.get("todo");
      bucket.push(card);
    }
    for (const list of byStatus.values()) {
      list.sort(
        (a, b) =>
          (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0) ||
          a.filename.localeCompare(b.filename)
      );
    }

    const priorityColor = (p) => (p === "high" ? t.blocked : p === "medium" ? t.working : t.dim);

    return v_flex()
      .id("kanban")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(svg("mods/workspace-chrome/layers.svg").size(14).flex_none().text_color(t.muted))
          .child(div().font_semibold().child("Kanban"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(projectName))
          .child(
            div()
              .id("kanban-refresh")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11.5)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.load(cx, false))
              .child("↻")
          )
      )
      .child(
        v_flex()
          .id("kanban-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(8)
          .gap(10)
          .when(this.loading && this.cards.length === 0, (el) =>
            el.child(div().p(8).text_size(12).text_color(t.dim).child("Loading .kanban/…"))
          )
          .when(!this.loading && this.cards.length === 0, (el) =>
            el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || "No cards in .kanban/"))
          )
          .children(
            STATUS_ORDER.filter((s) => (byStatus.get(s.id)?.length ?? 0) > 0).map((group) => {
              const items = byStatus.get(group.id);
              const collapsed = this.collapsedGroups.has(group.id);
              return v_flex()
                .id(`kb-group-${group.id}`)
                .gap(4)
                .child(
                  h_flex()
                    .id(`kb-hdr-${group.id}`)
                    .h(24)
                    .px(6)
                    .gap(6)
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      if (collapsed) this.collapsedGroups.delete(group.id);
                      else this.collapsedGroups.add(group.id);
                      cx.notify();
                    })
                    .child(
                      svg(`mods/workspace-chrome/chevron-${collapsed ? "right" : "down"}.svg`)
                        .size(11)
                        .flex_none()
                        .text_color(t.dim)
                    )
                    .child(div().size(6).rounded_full().bg(t[group.color] ?? t.dim))
                    .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(group.label))
                    .child(div().text_size(11).text_color(t.dim).child(String(items.length)))
                )
                .when(!collapsed, (el) =>
                  el.children(
                    items.map((card) =>
                      v_flex()
                        .id(`kb-card-${card.filename}`)
                        .px(9)
                        .py(7)
                        .gap(4)
                        .rounded(7)
                        .bg(t.surface)
                        .border(1)
                        .border_color(t.border)
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover))
                        .on_click(() => this.openCard(card))
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(card.title))
                            .when(card.total > 0, (row) =>
                              row.child(
                                div()
                                  .flex_none()
                                  .text_size(11)
                                  .text_color(card.checked === card.total ? t.done : t.dim)
                                  .child(`${card.checked}/${card.total}`)
                              )
                            )
                        )
                        .child(
                          h_flex()
                            .gap(5)
                            .items_center()
                            .child(
                              div()
                                .px(5)
                                .py(1)
                                .rounded(4)
                                .bg(t.raised)
                                .text_size(10)
                                .text_color(priorityColor(card.priority))
                                .child(card.priority)
                            )
                            .children(
                              card.tags.slice(0, 3).map((tag) =>
                                div()
                                  .px(5)
                                  .py(1)
                                  .rounded(4)
                                  .bg(t.raised)
                                  .text_size(10)
                                  .text_color(t.dim)
                                  .child(tag)
                              )
                            )
                        )
                    )
                  )
                );
            })
          )
      );
  }
}
