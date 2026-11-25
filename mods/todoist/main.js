// Todoist active tasks panel: reads TODOIST_API_TOKEN from ~/.config/herdr-app/.env.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { appHome, readTextFile, theme } from "herdr";

const API_BASE = "https://api.todoist.com/api/v1";

async function loadToken() {
  try {
    const raw = await readTextFile(`${appHome().replace(/[\\/]+$/, "")}/.env`, { on: null });
    if (!raw) return null;
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*TODOIST_API_TOKEN\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    // ignore
  }
  return null;
}

export default class Todoist extends View {
  init(_props, cx) {
    this.token = null;
    this.tasks = [];
    this.projects = new Map();
    this.loading = true;
    this.error = null;
    this.copiedId = null;
    this.closing = new Set();
    this.adding = false;
    this.addInput = InputState.new({ placeholder: "Quick add task (Enter)..." });
    this.addInput.on("submit", (_e, cx) => this.addTask(cx));
    this.refresh(cx, false);
    cx.timer.every(60000, (cx) => this.refresh(cx, true));
  }

  refresh(cx, silent = false) {
    if (!silent) {
      this.loading = true;
      this.error = null;
      cx.notify();
    }
    cx.spawn(async (cx) => {
      try {
        const token = await loadToken();
        this.token = token;
        if (!token) {
          this.tasks = [];
          this.error = "missing_token";
          return;
        }
        const headers = { Authorization: `Bearer ${token}` };
        const [tasksRes, projRes] = await Promise.all([
          fetch(`${API_BASE}/tasks`, { headers }),
          this.projects.size === 0 ? fetch(`${API_BASE}/projects`, { headers }) : Promise.resolve(null),
        ]);
        if (!tasksRes.ok) {
          this.error = `Todoist API error (${tasksRes.status})`;
          return;
        }
        const tasksJson = await tasksRes.json();
        const tasks = Array.isArray(tasksJson) ? tasksJson : tasksJson?.results;
        if (projRes?.ok) {
          const projJson = await projRes.json();
          const projs = Array.isArray(projJson) ? projJson : projJson?.results;
          if (Array.isArray(projs)) {
            this.projects = new Map(projs.map((p) => [p.id, p.name]));
          }
        }
        if (Array.isArray(tasks)) {
          tasks.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1) || (a.child_order ?? a.order ?? 0) - (b.child_order ?? b.order ?? 0));
          this.tasks = tasks;
        }
        this.error = null;
      } catch (err) {
        this.error = String(err?.message || err || "Failed to load Todoist tasks");
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  completeTask(task, cx) {
    if (!this.token || this.closing.has(task.id)) return;
    this.closing.add(task.id);
    const prev = this.tasks;
    this.tasks = this.tasks.filter((t) => t.id !== task.id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(task.id)}/close`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        this.tasks = prev;
      } finally {
        this.closing.delete(task.id);
        cx.notify();
      }
    });
  }

  addTask(cx) {
    const content = this.addInput.value().trim();
    if (!content || !this.token || this.adding) return;
    this.adding = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(`${API_BASE}/tasks`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content }),
        });
        if (res.ok) {
          const created = await res.json();
          this.addInput.set_value("");
          this.tasks = [created, ...this.tasks];
        }
      } catch {
        // ignore
      } finally {
        this.adding = false;
        cx.notify();
      }
    });
  }

  copyTask(task, cx) {
    const text = task.description ? `${task.content}\n\n${task.description}` : task.content;
    cx.write_to_clipboard(text);
    this.copiedId = task.id;
    cx.notify();
    cx.spawn(async (cx) => {
      await cx.sleep(1500);
      if (this.copiedId === task.id) {
        this.copiedId = null;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const prioColor = (p) => (p === 4 ? t.blocked : p === 3 ? t.working : p === 2 ? t.accent : t.dim);

    return v_flex()
      .id("todoist")
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
          .child(svg("mods/workspace-chrome/circle-check.svg").size(14).flex_none().text_color(t.muted))
          .child(div().font_semibold().child("Todoist"))
          .child(div().text_size(11.5).text_color(t.dim).child(this.tasks.length ? String(this.tasks.length) : ""))
          .child(div().flex_1())
          .child(
            div()
              .id("todoist-refresh")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11.5)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.refresh(cx, false))
              .child("↻")
          )
      )
      .when(Boolean(this.token), (el) =>
        el.child(
          h_flex()
            .px(10)
            .py(7)
            .gap(6)
            .flex_none()
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .child(
              Input.new(this.addInput)
                .flex_1()
                .min_w(0)
                .h(26)
                .px(8)
                .rounded(6)
                .bg(t.input)
                .border(1)
                .border_color(t.border)
                .text_size(12)
                .text_color(t.foreground)
            )
        )
      )
      .child(
        v_flex()
          .id("todoist-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(8)
          .gap(5)
          .when(this.error === "missing_token", (el) =>
            el.child(
              v_flex()
                .p(10)
                .gap(6)
                .rounded(8)
                .bg(t.surface)
                .border(1)
                .border_color(t.border)
                .child(div().font_semibold().text_size(12.5).child("Todoist token not found"))
                .child(div().text_size(11.5).text_color(t.muted).child("Add TODOIST_API_TOKEN=... to ~/.config/herdr-app/.env, then click ↻."))
            )
          )
          .when(Boolean(this.error) && this.error !== "missing_token", (el) =>
            el.child(div().p(8).text_size(12).text_color(t.blocked).child(this.error))
          )
          .when(!this.error && this.loading && this.tasks.length === 0, (el) =>
            el.child(div().p(8).text_size(12).text_color(t.dim).child("Loading Todoist tasks…"))
          )
          .when(!this.error && !this.loading && this.tasks.length === 0, (el) =>
            el.child(div().p(8).text_size(12).text_color(t.dim).child("All caught up! No active tasks."))
          )
          .children(
            this.tasks.map((task) => {
              const proj = this.projects.get(task.project_id);
              const copied = this.copiedId === task.id;
              return h_flex()
                .id(`td-${task.id}`)
                .px(9)
                .py(7)
                .gap(8)
                .items_start()
                .rounded(7)
                .bg(t.surface)
                .border(1)
                .border_color(t.border)
                .hover((s) => s.bg(t.hover))
                .child(
                  div()
                    .id(`td-check-${task.id}`)
                    .mt(2)
                    .size(15)
                    .flex_none()
                    .rounded_full()
                    .border(1.5)
                    .border_color(prioColor(task.priority))
                    .cursor_pointer()
                    .tooltip("Mark complete")
                    .hover((s) => s.bg(t.done + "33").border_color(t.done))
                    .on_click((_e, cx) => this.completeTask(task, cx))
                )
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(3)
                    .child(div().text_size(12.5).text_color(t.foreground).child(task.content))
                    .when(Boolean(task.description), (col) =>
                      col.child(div().text_size(11).text_color(t.muted).truncate().child(task.description))
                    )
                    .when(Boolean(proj) || Boolean(task.due?.string), (col) =>
                      col.child(
                        h_flex()
                          .gap(5)
                          .items_center()
                          .when(Boolean(proj), (row) =>
                            row.child(div().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(proj))
                          )
                          .when(Boolean(task.due?.string), (row) =>
                            row.child(div().text_size(10.5).text_color(t.working).child(task.due.string))
                          )
                      )
                    )
                )
                .child(
                  div()
                    .id(`td-copy-${task.id}`)
                    .px(6)
                    .py(2)
                    .flex_none()
                    .rounded(5)
                    .text_size(11)
                    .cursor_pointer()
                    .bg(t.raised)
                    .text_color(copied ? t.done : t.muted)
                    .hover((s) => s.bg(t.selected).text_color(t.foreground))
                    .tooltip("Copy task to clipboard")
                    .on_click((_e, cx) => this.copyTask(task, cx))
                    .child(copied ? "Copied" : "Copy")
                );
            })
          )
      );
  }
}
