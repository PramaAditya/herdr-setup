// Task Detail & Notes Inspector view for Todoist Hub.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import {
  PRIORITIES,
  dueStatus,
  formatRelativeTime,
  priorityColor,
  todoistColor,
} from "./format.js";

export function initDetailState(view) {
  view.detailTaskId = null;
  view.detailDirty = false;
  view.detailSaving = false;
  view.detailSavedAt = 0;
  view.detailConfirmDelete = false;
  view.detailPicker = null; // "project" | "due" | "labels" | null
  view.detailAddingSub = false;
  view.detailAddingComment = false;

  view.detailTitleInput = InputState.new({ placeholder: "Task title..." });
  view.detailDescInput = TextareaState.new({ placeholder: "Notes, coding ideas, links...", rows: 4 });
  view.detailDescInput.set_auto_grow(3, 12);
  view.detailDescInput.set_soft_wrap(true);

  view.detailDueInput = InputState.new({ placeholder: "e.g. tomorrow, fri 5pm, every mon" });
  view.detailSubtaskInput = InputState.new({ placeholder: "+ Add subtask (Enter)..." });
  view.detailCommentInput = InputState.new({ placeholder: "+ Add follow-up note (Enter)..." });
  view.detailNewLabelInput = InputState.new({ placeholder: "Create new label (Enter)..." });

  const markDirty = (_e, cx) => {
    const task = view.getSelectedTask();
    if (!task) return;
    const nextDirty =
      view.detailTitleInput.value() !== (task.content || "") ||
      view.detailDescInput.value() !== (task.description || "");
    if (nextDirty !== view.detailDirty) {
      view.detailDirty = nextDirty;
      cx.notify();
    }
  };
  view.detailTitleInput.on("change", markDirty);
  view.detailDescInput.on("change", markDirty);
  view.detailTitleInput.on("submit", (_e, cx) => saveDetailTask(view, cx));
  view.detailDueInput.on("submit", (_e, cx) => applyCustomDue(view, cx));
  view.detailSubtaskInput.on("submit", (_e, cx) => submitSubtask(view, cx));
  view.detailCommentInput.on("submit", (_e, cx) => submitComment(view, cx));
  view.detailNewLabelInput.on("submit", (_e, cx) => submitNewLabel(view, cx));
}

export function releaseDetailState(view) {
  view.detailTitleInput?.release();
  view.detailDescInput?.release();
  view.detailDueInput?.release();
  view.detailSubtaskInput?.release();
  view.detailCommentInput?.release();
  view.detailNewLabelInput?.release();
}

export function selectDetailTask(view, task, cx) {
  if (!task) {
    view.detailTaskId = null;
    view.detailDirty = false;
    view.detailConfirmDelete = false;
    view.detailPicker = null;
    if (cx) cx.notify();
    return;
  }
  const changed = view.detailTaskId !== task.id;
  view.detailTaskId = task.id;
  view.detailDirty = false;
  view.detailConfirmDelete = false;
  if (changed) view.detailPicker = null;
  view.detailTitleInput.set_value(task.content || "");
  view.detailDescInput.set_value(task.description || "");
  view.detailDueInput.set_value(task.due?.string || "");
  view.detailSubtaskInput.set_value("");
  view.detailCommentInput.set_value("");
  view.detailNewLabelInput.set_value("");
  if (cx) {
    cx.spawn(async () => {
      await view.store.loadComments(task.id);
    });
    cx.notify();
  }
}

export function saveDetailTask(view, cx) {
  const task = view.getSelectedTask();
  if (!task || view.detailSaving) return;
  const content = view.detailTitleInput.value().trim();
  const description = view.detailDescInput.value();
  if (!content) return;
  view.detailSaving = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      await view.store.updateTask(task.id, { content, description });
      view.detailDirty = false;
      view.detailSavedAt = Date.now();
    } catch (err) {
      view.store.error = String(err?.message || err);
    } finally {
      view.detailSaving = false;
      cx.notify();
    }
  });
}

function applyDueString(view, dueString, cx) {
  const task = view.getSelectedTask();
  if (!task) return;
  cx.spawn(async (cx) => {
    try {
      await view.store.updateTask(task.id, { due_string: dueString });
      view.detailDueInput.set_value(dueString === "no date" ? "" : dueString);
      view.detailPicker = null;
    } catch (err) {
      view.store.error = String(err?.message || err);
    } finally {
      cx.notify();
    }
  });
}

function applyCustomDue(view, cx) {
  const raw = view.detailDueInput.value().trim();
  applyDueString(view, raw || "no date", cx);
}

function submitSubtask(view, cx) {
  const task = view.getSelectedTask();
  const content = view.detailSubtaskInput.value().trim();
  if (!task || !content || view.detailAddingSub) return;
  view.detailAddingSub = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      await view.store.addSubtask(task, content);
      view.detailSubtaskInput.set_value("");
    } catch (err) {
      view.store.error = String(err?.message || err);
    } finally {
      view.detailAddingSub = false;
      cx.notify();
    }
  });
}

function submitComment(view, cx) {
  const task = view.getSelectedTask();
  const content = view.detailCommentInput.value().trim();
  if (!task || !content || view.detailAddingComment) return;
  view.detailAddingComment = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      await view.store.addComment(task.id, content);
      view.detailCommentInput.set_value("");
    } catch (err) {
      view.store.error = String(err?.message || err);
    } finally {
      view.detailAddingComment = false;
      cx.notify();
    }
  });
}

function submitNewLabel(view, cx) {
  const task = view.getSelectedTask();
  const name = view.detailNewLabelInput.value().trim().replace(/^@+/, "");
  if (!task || !name) return;
  cx.spawn(async (cx) => {
    try {
      if (!view.store.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
        await view.store.createLabel(name);
      }
      const next = Array.from(new Set([...(task.labels || []), name]));
      await view.store.updateTask(task.id, { labels: next });
      view.detailNewLabelInput.set_value("");
    } catch (err) {
      view.store.error = String(err?.message || err);
    } finally {
      cx.notify();
    }
  });
}

function toggleLabel(view, task, labelName, cx) {
  const current = task.labels || [];
  const next = current.includes(labelName)
    ? current.filter((x) => x !== labelName)
    : [...current, labelName];
  cx.spawn(async (cx) => {
    try {
      await view.store.updateTask(task.id, { labels: next });
    } catch (err) {
      view.store.error = String(err?.message || err);
    } finally {
      cx.notify();
    }
  });
}

function chipBtn(id, label, active, t, onClick, { color, dot } = {}) {
  return h_flex()
    .id(id)
    .px(7)
    .py(3)
    .gap(5)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .text_size(11.5)
    .bg(active ? t.selected : t.raised)
    .border(1)
    .border_color(active ? t.accent : t.border)
    .text_color(color || (active ? t.foreground : t.muted))
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click(onClick)
    .when(Boolean(dot), (el) => el.child(div().size(7).rounded_full().bg(dot).flex_none()))
    .child(label);
}

export function renderTaskDetail(view, task, t, cx, { showBack = true } = {}) {
  if (!task) {
    return v_flex()
      .size_full()
      .items_center()
      .justify_center()
      .p(20)
      .gap(6)
      .child(div().text_size(13).font_medium().text_color(t.muted).child("Select a task"))
      .child(div().text_size(11.5).text_color(t.dim).child("Click any task to edit notes, move projects, or add subtasks & comments."));
  }

  const store = view.store;
  const project = store.projectById.get(task.project_id);
  const section = task.section_id ? store.sectionById.get(task.section_id) : null;
  const parentTask = task.parent_id ? store.tasks.find((x) => x.id === task.parent_id) : null;
  const subtasks = store.tasks
    .filter((x) => x.parent_id === task.id)
    .sort((a, b) => (a.child_order ?? a.order ?? 0) - (b.child_order ?? b.order ?? 0));
  const comments = store.commentsByTask.get(task.id) ?? [];
  const commentsLoading = store.commentsLoading.has(task.id);
  const due = dueStatus(task.due);
  const isCompleted = Boolean(task.checked);
  const justSaved = !view.detailDirty && Date.now() - view.detailSavedAt < 2000;
  const copied = view.copiedId === task.id;
  const pasted = view.pastedId === task.id;

  const dueColor =
    due.kind === "overdue" ? t.blocked : due.kind === "today" ? t.done : due.kind === "tomorrow" ? t.working : t.muted;

  const togglePicker = (name, cx) => {
    view.detailPicker = view.detailPicker === name ? null : name;
    cx.notify();
  };

  return v_flex()
    .id(`td-detail-${task.id}`)
    .size_full()
    .min_h(0)
    .bg(t.background)
    .on_key_down((e, cx) => {
      if ((e.modifiers.control || e.modifiers.platform) && e.key.toLowerCase() === "s") {
        cx.stop_propagation();
        saveDetailTask(view, cx);
      } else if (e.key === "escape" && showBack) {
        cx.stop_propagation();
        selectDetailTask(view, null, cx);
      }
    })
    // Top action bar
    .child(
      h_flex()
        .h(38)
        .flex_none()
        .px(10)
        .gap(6)
        .items_center()
        .bg(t.surface)
        .border_b(1)
        .border_color(t.border)
        .when(showBack, (el) =>
          el.child(
            div()
              .id("td-detail-back")
              .px(6)
              .py(3)
              .rounded(5)
              .cursor_pointer()
              .text_size(12)
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => selectDetailTask(view, null, cx))
              .child("← Back")
          )
        )
        .child(
          div()
            .id("td-detail-complete")
            .size(16)
            .flex_none()
            .rounded_full()
            .border(1.5)
            .border_color(isCompleted ? t.done : priorityColor(task.priority, t))
            .bg(isCompleted ? t.done : t.background)
            .cursor_pointer()
            .tooltip(isCompleted ? "Reopen task" : "Mark complete")
            .hover((s) => s.bg(t.done + "44").border_color(t.done))
            .on_click((_e, cx) => {
              cx.spawn(async (cx) => {
                if (isCompleted) {
                  await store.reopenTask(task);
                } else {
                  await store.completeTask(task);
                  if (showBack) selectDetailTask(view, null, cx);
                }
                cx.notify();
              });
            })
        )
        .when(Boolean(parentTask), (el) =>
          el.child(
            div()
              .id("td-detail-parent")
              .px(6)
              .py(2)
              .rounded(5)
              .cursor_pointer()
              .text_size(11)
              .text_color(t.accent)
              .truncate()
              .max_w(120)
              .hover((s) => s.bg(t.hover))
              .tooltip(`Go to parent: ${parentTask.content}`)
              .on_click((_e, cx) => selectDetailTask(view, parentTask, cx))
              .child(`↑ ${parentTask.content}`)
          )
        )
        .child(div().flex_1())
        .when(view.detailDirty || view.detailSaving || justSaved, (el) =>
          el.child(
            div()
              .id("td-detail-save")
              .px(8)
              .py(2)
              .rounded(5)
              .text_size(11)
              .cursor_pointer()
              .bg(view.detailDirty ? t.accent : t.raised)
              .text_color(view.detailDirty ? t.background : t.done)
              .hover((s) => s.bg(view.detailDirty ? t.accent : t.hover))
              .tooltip("Save changes (Ctrl+S)")
              .on_click((_e, cx) => saveDetailTask(view, cx))
              .child(view.detailSaving ? "Saving…" : view.detailDirty ? "Save" : "Saved")
          )
        )
        .child(
          div()
            .id("td-detail-paste")
            .px(7)
            .py(2)
            .rounded(5)
            .text_size(11)
            .cursor_pointer()
            .bg(t.raised)
            .text_color(pasted ? t.done : t.muted)
            .hover((s) => s.bg(t.selected).text_color(t.foreground))
            .tooltip("Paste formatted idea into focused terminal (no Enter)")
            .on_click((_e, cx) => view.pasteTaskToTerminal(task, cx))
            .child(pasted ? "Pasted" : "Paste")
        )
        .child(
          div()
            .id("td-detail-copy")
            .px(7)
            .py(2)
            .rounded(5)
            .text_size(11)
            .cursor_pointer()
            .bg(t.raised)
            .text_color(copied ? t.done : t.muted)
            .hover((s) => s.bg(t.selected).text_color(t.foreground))
            .tooltip("Copy task + notes + subtasks as Markdown")
            .on_click((_e, cx) => view.copyTask(task, cx))
            .child(copied ? "Copied" : "Copy")
        )
        .child(
          div()
            .id("td-detail-delete")
            .px(7)
            .py(2)
            .rounded(5)
            .text_size(11)
            .cursor_pointer()
            .bg(view.detailConfirmDelete ? t.blocked : t.raised)
            .text_color(view.detailConfirmDelete ? t.background : t.muted)
            .hover((s) => s.bg(t.blocked).text_color(t.background))
            .tooltip(view.detailConfirmDelete ? "Click again to permanently delete" : "Delete task")
            .on_click((_e, cx) => {
              if (!view.detailConfirmDelete) {
                view.detailConfirmDelete = true;
                cx.notify();
                return;
              }
              cx.spawn(async (cx) => {
                await store.deleteTask(task.id);
                selectDetailTask(view, null, cx);
              });
            })
            .child(view.detailConfirmDelete ? "Confirm?" : "×")
        )
    )
    // Scrollable body
    .child(
      v_flex()
        .id("td-detail-scroll")
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .p(12)
        .gap(12)
        // Title & Notes editors
        .child(
          v_flex()
            .gap(8)
            .child(
              Input.new(view.detailTitleInput)
                .w_full()
                .h(32)
                .px(9)
                .rounded(6)
                .bg(t.input)
                .border(1)
                .border_color(view.detailDirty ? t.accent : t.border)
                .text_size(13)
                .font_semibold()
                .text_color(t.foreground)
            )
            .child(
              Textarea.new(view.detailDescInput)
                .w_full()
                .p(8)
                .rounded(6)
                .bg(t.input)
                .border(1)
                .border_color(t.border)
                .text_size(12)
                .text_color(t.foreground)
            )
        )
        // Triage property chips
        .child(
          h_flex()
            .flex_wrap()
            .gap(6)
            .items_center()
            .child(
              chipBtn(
                "td-prop-proj",
                section ? `${project?.name || "Inbox"} / ${section.name}` : project?.name || "Inbox",
                view.detailPicker === "project",
                t,
                (_e, cx) => togglePicker("project", cx),
                { dot: todoistColor(project?.color, t.dim) }
              )
            )
            .child(
              chipBtn(
                "td-prop-due",
                due.label ? `📅 ${due.label}` : "📅 Due date",
                view.detailPicker === "due",
                t,
                (_e, cx) => togglePicker("due", cx),
                { color: due.label ? dueColor : t.muted }
              )
            )
            .child(
              chipBtn(
                "td-prop-labels",
                task.labels?.length ? task.labels.map((l) => `@${l}`).join(" ") : "@ Labels",
                view.detailPicker === "labels",
                t,
                (_e, cx) => togglePicker("labels", cx)
              )
            )
        )
        // Priority strip
        .child(
          h_flex()
            .gap(5)
            .items_center()
            .child(div().text_size(11).text_color(t.dim).mr(2).child("Priority"))
            .children(
              PRIORITIES.map((p) => {
                const active = (task.priority ?? 1) === p.value;
                const col = priorityColor(p.value, t);
                return div()
                  .id(`td-prio-${p.value}`)
                  .px(8)
                  .py(2)
                  .rounded(5)
                  .text_size(11)
                  .font_medium()
                  .cursor_pointer()
                  .border(1)
                  .border_color(active ? col : t.border)
                  .bg(active ? t.selected : t.surface)
                  .text_color(active ? col : t.muted)
                  .hover((s) => s.bg(t.hover).text_color(col))
                  .tooltip(p.title)
                  .on_click((_e, cx) => {
                    cx.spawn(async (cx) => {
                      await store.updateTask(task.id, { priority: p.value });
                      cx.notify();
                    });
                  })
                  .child(p.label);
              })
            )
        )
        // Expandable Project / Section picker
        .when(view.detailPicker === "project", (el) =>
          el.child(
            v_flex()
              .p(8)
              .gap(6)
              .rounded(8)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .child(div().text_size(11).font_semibold().text_color(t.muted).child("Move to Project / Section"))
              .child(
                v_flex()
                  .gap(3)
                  .children(
                    store.projects.flatMap((proj) => {
                      const isCurProj = task.project_id === proj.id && !task.section_id;
                      const pSecs = store.sectionsForProject(proj.id);
                      const rows = [
                        h_flex()
                          .id(`td-mv-p-${proj.id}`)
                          .px(8)
                          .py(5)
                          .gap(7)
                          .rounded(6)
                          .items_center()
                          .cursor_pointer()
                          .bg(isCurProj ? t.selected : t.surface)
                          .text_size(12)
                          .text_color(isCurProj ? t.foreground : t.muted)
                          .hover((s) => s.bg(t.hover).text_color(t.foreground))
                          .on_click((_e, cx) => {
                            view.detailPicker = null;
                            cx.spawn(async (cx) => {
                              await store.moveTask(task.id, { project_id: proj.id });
                              cx.notify();
                            });
                          })
                          .child(div().size(7).rounded_full().bg(todoistColor(proj.color, t.dim)).flex_none())
                          .child(div().flex_1().truncate().child(proj.name))
                          .when(isCurProj, (r) => r.child(div().text_size(11).text_color(t.accent).child("✓"))),
                      ];
                      for (const sec of pSecs) {
                        const isCurSec = task.section_id === sec.id;
                        rows.push(
                          h_flex()
                            .id(`td-mv-s-${sec.id}`)
                            .pl(24)
                            .pr(8)
                            .py(4)
                            .gap(6)
                            .rounded(6)
                            .items_center()
                            .cursor_pointer()
                            .bg(isCurSec ? t.selected : t.surface)
                            .text_size(11.5)
                            .text_color(isCurSec ? t.foreground : t.dim)
                            .hover((s) => s.bg(t.hover).text_color(t.foreground))
                            .on_click((_e, cx) => {
                              view.detailPicker = null;
                              cx.spawn(async (cx) => {
                                await store.moveTask(task.id, { project_id: proj.id, section_id: sec.id });
                                cx.notify();
                              });
                            })
                            .child(div().flex_1().truncate().child(`↳ ${sec.name}`))
                            .when(isCurSec, (r) => r.child(div().text_size(11).text_color(t.accent).child("✓")))
                        );
                      }
                      return rows;
                    })
                  )
              )
          )
        )
        // Expandable Due Date picker
        .when(view.detailPicker === "due", (el) =>
          el.child(
            v_flex()
              .p(8)
              .gap(7)
              .rounded(8)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .child(div().text_size(11).font_semibold().text_color(t.muted).child("Schedule Due Date"))
              .child(
                h_flex()
                  .flex_wrap()
                  .gap(5)
                  .children(
                    [
                      { id: "today", label: "Today", val: "today" },
                      { id: "tomorrow", label: "Tomorrow", val: "tomorrow" },
                      { id: "next-week", label: "Next week", val: "next monday" },
                      { id: "clear", label: "No date", val: "no date" },
                    ].map((preset) =>
                      div()
                        .id(`td-due-${preset.id}`)
                        .px(8)
                        .py(3)
                        .rounded(5)
                        .text_size(11.5)
                        .cursor_pointer()
                        .bg(t.raised)
                        .border(1)
                        .border_color(t.border)
                        .text_color(preset.id === "clear" ? t.blocked : t.foreground)
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => applyDueString(view, preset.val, cx))
                        .child(preset.label)
                    )
                  )
              )
              .child(
                h_flex()
                  .gap(6)
                  .child(
                    Input.new(view.detailDueInput)
                      .flex_1()
                      .min_w(0)
                      .h(26)
                      .px(8)
                      .rounded(5)
                      .bg(t.input)
                      .border(1)
                      .border_color(t.border)
                      .text_size(11.5)
                      .text_color(t.foreground)
                  )
                  .child(
                    div()
                      .id("td-due-apply")
                      .px(8)
                      .h(26)
                      .flex()
                      .items_center()
                      .rounded(5)
                      .cursor_pointer()
                      .bg(t.accent)
                      .text_size(11.5)
                      .text_color(t.background)
                      .on_click((_e, cx) => applyCustomDue(view, cx))
                      .child("Set")
                  )
              )
          )
        )
        // Expandable Labels picker
        .when(view.detailPicker === "labels", (el) =>
          el.child(
            v_flex()
              .p(8)
              .gap(7)
              .rounded(8)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .child(div().text_size(11).font_semibold().text_color(t.muted).child("Labels"))
              .child(
                h_flex()
                  .flex_wrap()
                  .gap(5)
                  .when(store.labels.length === 0, (r) =>
                    r.child(div().text_size(11).text_color(t.dim).child("No labels yet — create one below."))
                  )
                  .children(
                    store.labels.map((lbl) => {
                      const on = (task.labels || []).includes(lbl.name);
                      return chipBtn(
                        `td-lbl-${lbl.id}`,
                        `@${lbl.name}`,
                        on,
                        t,
                        (_e, cx) => toggleLabel(view, task, lbl.name, cx),
                        { dot: todoistColor(lbl.color, t.dim) }
                      );
                    })
                  )
              )
              .child(
                Input.new(view.detailNewLabelInput)
                  .w_full()
                  .h(26)
                  .px(8)
                  .rounded(5)
                  .bg(t.input)
                  .border(1)
                  .border_color(t.border)
                  .text_size(11.5)
                  .text_color(t.foreground)
              )
          )
        )
        // Subtasks section
        .child(
          v_flex()
            .gap(6)
            .pt(4)
            .border_t(1)
            .border_color(t.border)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("Subtasks"))
                .when(subtasks.length > 0, (r) =>
                  r.child(div().text_size(11).text_color(t.dim).child(String(subtasks.length)))
                )
            )
            .children(
              subtasks.map((sub) =>
                h_flex()
                  .id(`td-sub-${sub.id}`)
                  .px(8)
                  .py(5)
                  .gap(7)
                  .items_center()
                  .rounded(6)
                  .bg(t.surface)
                  .border(1)
                  .border_color(t.border)
                  .hover((s) => s.bg(t.hover))
                  .child(
                    div()
                      .id(`td-sub-chk-${sub.id}`)
                      .size(13)
                      .flex_none()
                      .rounded_full()
                      .border(1.5)
                      .border_color(priorityColor(sub.priority, t))
                      .cursor_pointer()
                      .hover((s) => s.bg(t.done + "33").border_color(t.done))
                      .on_click((_e, cx) => {
                        cx.stop_propagation();
                        cx.spawn(async () => {
                          await store.completeTask(sub);
                        });
                      })
                  )
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(12)
                      .text_color(t.foreground)
                      .cursor_pointer()
                      .on_click((_e, cx) => selectDetailTask(view, sub, cx))
                      .child(sub.content)
                  )
              )
            )
            .child(
              Input.new(view.detailSubtaskInput)
                .w_full()
                .h(26)
                .px(8)
                .rounded(6)
                .bg(t.input)
                .border(1)
                .border_color(t.border)
                .text_size(11.5)
                .text_color(t.foreground)
            )
        )
        // Comments / Follow-up Notes section
        .child(
          v_flex()
            .gap(6)
            .pt(4)
            .border_t(1)
            .border_color(t.border)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("Comments"))
                .when(comments.length > 0, (r) =>
                  r.child(div().text_size(11).text_color(t.dim).child(String(comments.length)))
                )
            )
            .when(commentsLoading && comments.length === 0, (el) =>
              el.child(div().text_size(11.5).text_color(t.dim).child("Loading comments…"))
            )
            .children(
              comments.map((c) =>
                v_flex()
                  .id(`td-cmt-${c.id}`)
                  .px(9)
                  .py(7)
                  .gap(4)
                  .rounded(6)
                  .bg(t.surface)
                  .border(1)
                  .border_color(t.border)
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(div().text_size(10.5).text_color(t.dim).child(formatRelativeTime(c.posted_at)))
                      .child(div().flex_1())
                      .child(
                        div()
                          .id(`td-cmt-del-${c.id}`)
                          .px(4)
                          .rounded(4)
                          .text_size(11)
                          .text_color(t.dim)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover).text_color(t.blocked))
                          .tooltip("Delete comment")
                          .on_click((_e, cx) => {
                            cx.spawn(async () => {
                              await store.deleteComment(task.id, c.id);
                            });
                          })
                          .child("×")
                      )
                  )
                  .child(div().text_size(12).text_color(t.foreground).child(c.content))
              )
            )
            .child(
              Input.new(view.detailCommentInput)
                .w_full()
                .h(26)
                .px(8)
                .rounded(6)
                .bg(t.input)
                .border(1)
                .border_color(t.border)
                .text_size(11.5)
                .text_color(t.foreground)
            )
        )
        // Footer metadata
        .when(Boolean(task.added_at), (el) =>
          el.child(
            div()
              .pt(4)
              .text_size(10.5)
              .text_color(t.dim)
              .child(`Created ${formatRelativeTime(task.added_at)}`)
          )
        )
    );
}
