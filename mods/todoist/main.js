// Herdr Todoist Hub — flexible mobile-to-Herdr coding ideas inbox & project manager.
// Supports compact right-panel mode (default) and 1-click pop-out 3-column Tab mode.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { checking, panes, props, run, shared, spaces, theme } from "herdr";
import { getStore } from "./store.js";
import {
  SORT_MODES,
  buildSubtaskMap,
  dueStatus,
  filterTasksForView,
  formatRelativeTime,
  formatTaskMarkdown,
  groupBySections,
  isTodayOrOverdue,
  priorityColor,
  sortTasks,
  todoistColor,
} from "./format.js";
import {
  initDetailState,
  releaseDetailState,
  renderTaskDetail,
  selectDetailTask,
} from "./detail.js";
import {
  initProjectState,
  releaseProjectState,
  renderProjectsManager,
} from "./projects.js";

const VIEW_STORAGE_KEY = "herdr.todoist.view.v1";

function loadSavedView() {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveViewState(state) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export default class Todoist extends View {
  init(_props, cx) {
    this.store = getStore();
    this.isTabMode = props()?.mode === "tab";

    const saved = loadSavedView();
    this.activeView = saved?.view || "all"; // "all" | "inbox" | "today" | "project" | "label" | "done"
    this.activeProjectId = saved?.projectId || null;
    this.activeLabel = saved?.label || null;
    this.sortMode = saved?.sort || "newest";
    this.nlpMode = true; // default straight to Todoist NLP Quick Add

    this.searchOpen = false;
    this.searchQuery = "";
    this.managingProjects = false;
    this.adding = false;
    this.copiedId = null;
    this.pastedId = null;
    this.collapsedSections = new Set();
    this.lastFocusReq = Number(shared("todoist.focusQuickAdd") || 0);
    this.lastRev = Number(shared("todoist.rev") || 0);

    this.addInput = InputState.new({
      placeholder: "Quick add: idea tomorrow p1 #project @label (Enter)...",
    });
    this.addInput.on("submit", (_e, cx) => this.submitQuickAdd(cx));

    this.searchInput = InputState.new({ placeholder: "Search tasks, notes, #project, @label..." });
    this.searchInput.on("change", (_e, cx) => {
      this.searchQuery = this.searchInput.value();
      cx.notify();
    });

    initDetailState(this);
    initProjectState(this);

    this._unsub = this.store.subscribe(() => cx.notify());

    if (!checking()) {
      cx.spawn(async () => {
        if (!this.store.lastSyncAt) {
          await this.store.refresh(false);
        }
        if (this.activeView === "done") {
          await this.store.loadCompleted(false);
        }
      });
      cx.timer.every(60000, () => {
        this.store.refresh(true);
      });
      cx.timer.every(1500, (cx) => {
        if (this.store.undoItem && Date.now() >= this.store.undoItem.expiresAt) {
          this.store.undoItem = null;
          cx.notify();
        }
      });
    }
  }

  close() {
    this._unsub?.();
    this.addInput?.release();
    this.searchInput?.release();
    releaseDetailState(this);
    releaseProjectState(this);
  }

  getSelectedTask() {
    if (!this.detailTaskId) return null;
    return (
      this.store.tasks.find((t) => t.id === this.detailTaskId) ??
      this.store.completedTasks.find((t) => t.id === this.detailTaskId) ??
      null
    );
  }

  setActiveView(view, idOrLabel, cx) {
    this.activeView = view;
    if (view === "project" || view === "inbox") {
      this.activeProjectId = idOrLabel || this.store.inboxProject?.id || null;
      this.activeLabel = null;
    } else if (view === "label") {
      this.activeLabel = idOrLabel || null;
      this.activeProjectId = null;
    } else {
      this.activeProjectId = null;
      this.activeLabel = null;
    }
    this.managingProjects = false;
    if (!this.isTabMode) {
      selectDetailTask(this, null, null);
    }
    saveViewState({
      view: this.activeView,
      projectId: this.activeProjectId,
      label: this.activeLabel,
      sort: this.sortMode,
    });
    if (view === "done") {
      cx.spawn(async () => {
        await this.store.loadCompleted(false);
      });
    }
    cx.notify();
  }

  cycleSort(cx) {
    const idx = SORT_MODES.findIndex((m) => m.id === this.sortMode);
    this.sortMode = SORT_MODES[(idx + 1) % SORT_MODES.length].id;
    saveViewState({
      view: this.activeView,
      projectId: this.activeProjectId,
      label: this.activeLabel,
      sort: this.sortMode,
    });
    cx.notify();
  }

  submitQuickAdd(cx) {
    const text = this.addInput.value().trim();
    if (!text || !this.store.token || this.adding) return;
    this.adding = true;
    cx.notify();
    const scopedProject =
      !this.nlpMode && (this.activeView === "project" || this.activeView === "inbox")
        ? this.activeProjectId || this.store.inboxProject?.id
        : null;
    cx.spawn(async (cx) => {
      try {
        await this.store.addTask(text, { nlp: this.nlpMode, projectId: scopedProject });
        this.addInput.set_value("");
      } catch (err) {
        this.store.error = String(err?.message || err || "Failed to add task");
      } finally {
        this.adding = false;
        cx.notify();
      }
    });
  }

  formatForExport(task) {
    const projName = this.store.projectById.get(task.project_id)?.name;
    const subtasks = this.store.tasks.filter((x) => x.parent_id === task.id);
    const comments = this.store.commentsByTask.get(task.id) ?? [];
    return formatTaskMarkdown(task, { projectName: projName, subtasks, comments });
  }

  copyTask(task, cx) {
    cx.write_to_clipboard(this.formatForExport(task));
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

  pasteTaskToTerminal(task, cx) {
    const text = this.formatForExport(task);
    cx.write_to_clipboard(text);
    const allPanes = panes();
    const targetPane =
      allPanes.find((p) => p.pane === this.store.lastTerminalPane && p.terminal) ??
      allPanes.find((p) => p.focused && p.terminal) ??
      allPanes.find((p) => p.terminal);
    if (targetPane) {
      run("pane.focus", { pane: targetPane.pane });
      run("terminal.paste");
    }
    this.pastedId = task.id;
    cx.notify();
    cx.spawn(async (cx) => {
      await cx.sleep(1500);
      if (this.pastedId === task.id) {
        this.pastedId = null;
        cx.notify();
      }
    });
  }

  openHubTab() {
    const space = spaces().find((s) => s.active);
    const existing = space?.tabs.find(
      (t) => t.named && t.name === "Todoist" && panes().some((p) => p.tab === t.id && p.mod === "todoist")
    );
    if (existing) {
      run("tab.select", { id: existing.id });
      return;
    }
    run("tab.new", {
      name: "Todoist",
      space: space?.id,
      mod: "todoist",
      props: { mode: "tab" },
    });
  }

  renderHeader(t, visibleCount, cx) {
    const sortLabel = SORT_MODES.find((m) => m.id === this.sortMode)?.label ?? "Newest";
    const activeProj = this.activeProjectId ? this.store.projectById.get(this.activeProjectId) : null;
    const title = this.isTabMode
      ? this.activeView === "all"
        ? "All Tasks"
        : this.activeView === "inbox"
          ? "Inbox"
          : this.activeView === "today"
            ? "Today"
            : this.activeView === "done"
              ? "Completed (14d)"
              : this.activeView === "label"
                ? `@${this.activeLabel}`
                : activeProj?.name || "Project"
      : "Todoist";

    const hdrBtn = (id, label, tip, active, onClick) =>
      div()
        .id(id)
        .px(6)
        .py(2)
        .rounded(5)
        .text_size(11.5)
        .cursor_pointer()
        .bg(active ? t.selected : t.background)
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tip)
        .on_click(onClick)
        .child(label);

    return h_flex()
      .h(42)
      .flex_none()
      .px(12)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(svg("mods/workspace-chrome/circle-check.svg").size(14).flex_none().text_color(t.muted))
      .child(div().font_semibold().truncate().child(title))
      .child(div().text_size(11.5).text_color(t.dim).child(visibleCount ? String(visibleCount) : ""))
      .child(div().flex_1())
      .child(
        hdrBtn("td-search-btn", "⌕", "Search tasks", this.searchOpen, (_e, cx) => {
          this.searchOpen = !this.searchOpen;
          if (this.searchOpen) {
            this.searchInput.focus();
          } else {
            this.searchQuery = "";
            this.searchInput.set_value("");
          }
          cx.notify();
        })
      )
      .when(this.activeView !== "done", (el) =>
        el.child(hdrBtn("td-sort-btn", sortLabel, "Cycle sort order", false, (_e, cx) => this.cycleSort(cx)))
      )
      .when(!this.isTabMode, (el) =>
        el
          .child(
            hdrBtn("td-proj-mgr-btn", "⚙", "Manage Projects & Sections", this.managingProjects, (_e, cx) => {
              this.managingProjects = !this.managingProjects;
              cx.notify();
            })
          )
          .child(hdrBtn("td-popout-btn", "⤢", "Open full Todoist Hub tab", false, () => this.openHubTab()))
      )
      .child(
        hdrBtn("td-refresh-btn", "↻", "Sync with Todoist", false, (_e, cx) => {
          cx.spawn(async () => {
            await this.store.refresh(false);
            if (this.activeView === "done") await this.store.loadCompleted(true);
          });
        })
      );
  }

  renderProjectStrip(t, cx) {
    const store = this.store;
    const inbox = store.inboxProject;
    const todayCount = store.tasks.filter((x) => !x.parent_id && isTodayOrOverdue(x)).length;
    const allCount = store.tasks.filter((x) => !x.parent_id).length;
    const inboxCount = inbox ? store.countForProject(inbox.id) : 0;
    const customProjects = store.projects.filter((p) => !p.inbox_project && !p.is_inbox_project);

    const pill = (id, label, count, active, onClick, dot) =>
      h_flex()
        .id(id)
        .h(24)
        .px(8)
        .gap(5)
        .flex_none()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(11.5)
        .border(1)
        .border_color(active ? t.accent : t.border)
        .bg(active ? t.selected : t.surface)
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(onClick)
        .when(Boolean(dot), (el) => el.child(div().size(6).rounded_full().bg(dot).flex_none()))
        .child(label)
        .when(count > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(count))));

    return h_flex()
      .id("td-proj-strip")
      .h(36)
      .flex_none()
      .px(8)
      .gap(5)
      .items_center()
      .overflow_x_scroll()
      .border_b(1)
      .border_color(t.border)
      .child(pill("td-v-all", "All", allCount, this.activeView === "all", (_e, cx) => this.setActiveView("all", null, cx)))
      .when(Boolean(inbox), (el) =>
        el.child(
          pill(
            "td-v-inbox",
            "Inbox",
            inboxCount,
            this.activeView === "inbox",
            (_e, cx) => this.setActiveView("inbox", inbox.id, cx),
            todoistColor(inbox.color, t.accent)
          )
        )
      )
      .child(
        pill("td-v-today", "Today", todayCount, this.activeView === "today", (_e, cx) => this.setActiveView("today", null, cx))
      )
      .children(
        customProjects.map((p) =>
          pill(
            `td-v-p-${p.id}`,
            p.name,
            store.countForProject(p.id),
            this.activeView === "project" && this.activeProjectId === p.id,
            (_e, cx) => this.setActiveView("project", p.id, cx),
            todoistColor(p.color, t.dim)
          )
        )
      )
      .child(pill("td-v-done", "Done", 0, this.activeView === "done", (_e, cx) => this.setActiveView("done", null, cx)))
      .child(
        div()
          .id("td-v-add-proj")
          .h(24)
          .px(7)
          .flex()
          .flex_none()
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .text_size(11.5)
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Create or manage projects")
          .on_click((_e, cx) => {
            this.managingProjects = true;
            cx.notify();
          })
          .child("+")
      );
  }

  renderLeftSidebar(t, cx) {
    const store = this.store;
    const inbox = store.inboxProject;
    const allCount = store.tasks.filter((x) => !x.parent_id).length;
    const todayCount = store.tasks.filter((x) => !x.parent_id && isTodayOrOverdue(x)).length;
    const inboxCount = inbox ? store.countForProject(inbox.id) : 0;
    const customProjects = store.projects.filter((p) => !p.inbox_project && !p.is_inbox_project);

    const navItem = (id, label, count, active, onClick, dot) =>
      h_flex()
        .id(id)
        .h(28)
        .px(9)
        .gap(7)
        .rounded(6)
        .items_center()
        .cursor_pointer()
        .text_size(12.5)
        .bg(active ? t.selected : t.chrome)
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(onClick)
        .when(Boolean(dot), (el) => el.child(div().size(7).rounded_full().bg(dot).flex_none()))
        .child(div().flex_1().min_w(0).truncate().child(label))
        .when(count > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(count))));

    return v_flex()
      .w(220)
      .flex_none()
      .h_full()
      .bg(t.chrome)
      .border_r(1)
      .border_color(t.border)
      .child(
        h_flex()
          .h(42)
          .px(12)
          .gap(7)
          .flex_none()
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(svg("mods/workspace-chrome/circle-check.svg").size(14).flex_none().text_color(t.accent))
          .child(div().font_semibold().text_size(13).text_color(t.foreground).child("Todoist Hub"))
      )
      .child(
        v_flex()
          .id("td-tab-nav")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(8)
          .gap(3)
          .child(navItem("td-sb-all", "All Tasks", allCount, !this.managingProjects && this.activeView === "all", (_e, cx) => this.setActiveView("all", null, cx)))
          .when(Boolean(inbox), (el) =>
            el.child(
              navItem(
                "td-sb-inbox",
                "Inbox",
                inboxCount,
                !this.managingProjects && this.activeView === "inbox",
                (_e, cx) => this.setActiveView("inbox", inbox.id, cx),
                todoistColor(inbox.color, t.accent)
              )
            )
          )
          .child(navItem("td-sb-today", "Today", todayCount, !this.managingProjects && this.activeView === "today", (_e, cx) => this.setActiveView("today", null, cx)))
          .child(navItem("td-sb-done", "Completed", 0, !this.managingProjects && this.activeView === "done", (_e, cx) => this.setActiveView("done", null, cx)))
          // Projects header
          .child(
            h_flex()
              .px(8)
              .pt(10)
              .pb(3)
              .items_center()
              .justify_between()
              .child(div().text_size(11).font_semibold().text_color(t.dim).child("PROJECTS"))
              .child(
                div()
                  .id("td-sb-manage-proj")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .cursor_pointer()
                  .text_size(11)
                  .text_color(this.managingProjects ? t.accent : t.dim)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("Create / edit projects & sections")
                  .on_click((_e, cx) => {
                    this.managingProjects = !this.managingProjects;
                    cx.notify();
                  })
                  .child(this.managingProjects ? "Done" : "+ Manage")
              )
          )
          .children(
            customProjects.map((p) =>
              navItem(
                `td-sb-p-${p.id}`,
                p.name,
                store.countForProject(p.id),
                !this.managingProjects && this.activeView === "project" && this.activeProjectId === p.id,
                (_e, cx) => this.setActiveView("project", p.id, cx),
                todoistColor(p.color, t.dim)
              )
            )
          )
          // Labels section
          .when(store.labels.length > 0, (el) =>
            el
              .child(div().px(8).pt(10).pb(3).text_size(11).font_semibold().text_color(t.dim).child("LABELS"))
              .children(
                store.labels.map((l) =>
                  navItem(
                    `td-sb-l-${l.id}`,
                    `@${l.name}`,
                    store.tasks.filter((x) => !x.parent_id && (x.labels || []).includes(l.name)).length,
                    !this.managingProjects && this.activeView === "label" && this.activeLabel === l.name,
                    (_e, cx) => this.setActiveView("label", l.name, cx),
                    todoistColor(l.color, t.dim)
                  )
                )
              )
          )
      );
  }

  renderQuickAdd(t, cx) {
    const activeProj =
      (this.activeView === "project" || this.activeView === "inbox") && this.activeProjectId
        ? this.store.projectById.get(this.activeProjectId)
        : null;

    return h_flex()
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
          .h(28)
          .px(8)
          .rounded(6)
          .bg(t.input)
          .border(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.foreground)
      )
      .child(
        div()
          .id("td-nlp-toggle")
          .h(28)
          .px(7)
          .flex()
          .flex_none()
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .border(1)
          .border_color(this.nlpMode ? t.accent : t.border)
          .bg(this.nlpMode ? t.selected : t.raised)
          .text_size(11)
          .text_color(this.nlpMode ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(
            this.nlpMode
              ? "NLP Quick Add ON (parses #project @label p1 tomorrow). Click to add directly into current project."
              : `Adding directly into ${activeProj?.name || "Inbox"}. Click to switch back to NLP Quick Add.`
          )
          .on_click((_e, cx) => {
            this.nlpMode = !this.nlpMode;
            cx.notify();
          })
          .child(this.nlpMode ? "⚡ NLP" : `#${(activeProj?.name || "Inbox").slice(0, 10)}`)
      );
  }

  renderTaskCard(task, t, subtasksByParent, cx, { isDone = false } = {}) {
    const store = this.store;
    const proj = store.projectById.get(task.project_id);
    const subs = subtasksByParent.get(task.id) ?? [];
    const due = dueStatus(task.due);
    const copied = this.copiedId === task.id;
    const pasted = this.pastedId === task.id;
    const selected = this.isTabMode && this.detailTaskId === task.id;
    const showProjectBadge = this.activeView !== "project" && this.activeView !== "inbox" && Boolean(proj);
    const dueColor =
      due.kind === "overdue" ? t.blocked : due.kind === "today" ? t.done : due.kind === "tomorrow" ? t.working : t.dim;

    return h_flex()
      .id(`td-${isDone ? "done-" : ""}${task.id}`)
      .px(9)
      .py(7)
      .gap(8)
      .items_start()
      .rounded(7)
      .bg(selected ? t.selected : t.surface)
      .border(1)
      .border_color(selected ? t.accent : t.border)
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      // Checkbox
      .child(
        div()
          .id(`td-chk-${task.id}`)
          .mt(2)
          .size(15)
          .flex_none()
          .rounded_full()
          .border(1.5)
          .border_color(isDone ? t.done : priorityColor(task.priority, t))
          .bg(isDone ? t.done : t.surface)
          .cursor_pointer()
          .tooltip(isDone ? "Reopen task" : "Mark complete")
          .hover((s) => s.bg(t.done + "33").border_color(t.done))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            cx.spawn(async () => {
              if (isDone) await store.reopenTask(task);
              else await store.completeTask(task);
            });
          })
      )
      // Content column (click opens detail)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .cursor_pointer()
          .on_click((_e, cx) => {
            this.managingProjects = false;
            selectDetailTask(this, task, cx);
          })
          .child(
            div()
              .text_size(12.5)
              .text_color(isDone ? t.muted : t.foreground)
              .when(isDone, (el) => el.line_through())
              .child(task.content)
          )
          .when(Boolean(task.description), (col) =>
            col.child(div().text_size(11).text_color(t.muted).truncate().child(task.description))
          )
          .when(
            showProjectBadge ||
              Boolean(due.label) ||
              (task.labels?.length ?? 0) > 0 ||
              subs.length > 0 ||
              (task.note_count ?? 0) > 0 ||
              (isDone && Boolean(task.completed_at)),
            (col) =>
              col.child(
                h_flex()
                  .flex_wrap()
                  .gap(5)
                  .items_center()
                  .when(showProjectBadge, (row) =>
                    row.child(
                      h_flex()
                        .px(5)
                        .py(1)
                        .gap(4)
                        .items_center()
                        .rounded(4)
                        .bg(t.raised)
                        .child(div().size(6).rounded_full().bg(todoistColor(proj.color, t.dim)).flex_none())
                        .child(div().text_size(10).text_color(t.dim).child(proj.name))
                    )
                  )
                  .when(Boolean(due.label) && !isDone, (row) =>
                    row.child(div().text_size(10.5).text_color(dueColor).child(due.label))
                  )
                  .when(isDone && Boolean(task.completed_at), (row) =>
                    row.child(div().text_size(10).text_color(t.dim).child(`done ${formatRelativeTime(task.completed_at)}`))
                  )
                  .when(subs.length > 0, (row) =>
                    row.child(div().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(`↳ ${subs.length}`))
                  )
                  .when((task.note_count ?? 0) > 0, (row) =>
                    row.child(div().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(`💬 ${task.note_count}`))
                  )
                  .children(
                    (task.labels || []).slice(0, 3).map((lbl) =>
                      div()
                        .px(5)
                        .py(1)
                        .rounded(4)
                        .bg(t.raised)
                        .text_size(10)
                        .text_color(t.accent)
                        .child(`@${lbl}`)
                    )
                  )
              )
          )
      )
      // Right quick actions
      .child(
        h_flex()
          .gap(4)
          .flex_none()
          .when(!isDone, (row) =>
            row.child(
              div()
                .id(`td-paste-${task.id}`)
                .px(6)
                .py(2)
                .rounded(5)
                .text_size(10.5)
                .cursor_pointer()
                .bg(t.raised)
                .text_color(pasted ? t.done : t.muted)
                .hover((s) => s.bg(t.selected).text_color(t.foreground))
                .tooltip("Paste formatted idea into focused terminal (without Enter)")
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.pasteTaskToTerminal(task, cx);
                })
                .child(pasted ? "Pasted" : "Paste")
            )
          )
          .child(
            div()
              .id(`td-copy-${task.id}`)
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(10.5)
              .cursor_pointer()
              .bg(t.raised)
              .text_color(copied ? t.done : t.muted)
              .hover((s) => s.bg(t.selected).text_color(t.foreground))
              .tooltip("Copy Markdown to clipboard")
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.copyTask(task, cx);
              })
              .child(copied ? "Copied" : "Copy")
          )
      );
  }

  renderTaskList(t, cx) {
    const store = this.store;
    const inboxId = store.inboxProject?.id ?? null;
    const subtasksByParent = buildSubtaskMap(store.tasks);

    const isDoneView = this.activeView === "done";
    let visible = [];
    if (isDoneView) {
      const q = this.searchQuery.trim().toLowerCase();
      visible = store.completedTasks.filter((x) => {
        if (!q) return true;
        return `${x.content || ""}\n${x.description || ""}`.toLowerCase().includes(q);
      });
    } else {
      visible = sortTasks(
        filterTasksForView(store.tasks, {
          view: this.activeView,
          projectId: this.activeProjectId,
          labelName: this.activeLabel,
          search: this.searchQuery,
          inboxId,
          projectById: store.projectById,
        }),
        this.sortMode
      );
    }

    const activeProjectSections =
      !isDoneView && (this.activeView === "project" || this.activeView === "inbox") && this.activeProjectId
        ? store.sectionsForProject(this.activeProjectId)
        : [];
    const useSections = activeProjectSections.length > 0 && !this.searchQuery.trim();
    const groups = useSections ? groupBySections(visible, activeProjectSections) : null;

    const listEl = v_flex()
      .id("todoist-list")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .p(8)
      .gap(5)
      .when(store.error === "missing_token", (el) =>
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
      .when(Boolean(store.error) && store.error !== "missing_token", (el) =>
        el.child(
          h_flex()
            .p(8)
            .gap(8)
            .rounded(6)
            .bg(t.surface)
            .border(1)
            .border_color(t.blocked)
            .items_center()
            .child(div().flex_1().text_size(11.5).text_color(t.blocked).child(store.error))
            .child(
              div()
                .id("td-err-dismiss")
                .px(5)
                .cursor_pointer()
                .text_color(t.muted)
                .on_click((_e, cx) => {
                  store.error = null;
                  cx.notify();
                })
                .child("×")
            )
        )
      )
      .when(!store.error && (isDoneView ? store.completedLoading : store.loading) && visible.length === 0, (el) =>
        el.child(div().p(8).text_size(12).text_color(t.dim).child(isDoneView ? "Loading completed tasks…" : "Loading Todoist…"))
      )
      .when(!store.error && !(isDoneView ? store.completedLoading : store.loading) && visible.length === 0, (el) =>
        el.child(
          div()
            .p(10)
            .text_size(12)
            .text_color(t.dim)
            .child(
              this.searchQuery.trim()
                ? `No tasks matching "${this.searchQuery.trim()}".`
                : isDoneView
                  ? "No completed tasks in the last 14 days."
                  : "All caught up! Add a coding idea above."
            )
        )
      );

    if (groups) {
      for (const grp of groups) {
        if (!grp.name && grp.tasks.length === 0) continue;
        const secKey = grp.id || "__unsectioned__";
        const collapsed = this.collapsedSections.has(secKey);
        if (grp.name) {
          listEl.child(
            h_flex()
              .id(`td-sec-hdr-${secKey}`)
              .h(24)
              .px(6)
              .mt(4)
              .gap(6)
              .items_center()
              .rounded(5)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                if (collapsed) this.collapsedSections.delete(secKey);
                else this.collapsedSections.add(secKey);
                cx.notify();
              })
              .child(div().text_size(10.5).text_color(t.dim).child(collapsed ? "▸" : "▾"))
              .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(grp.name))
              .child(div().text_size(10.5).text_color(t.dim).child(String(grp.tasks.length)))
          );
        }
        if (!collapsed) {
          for (const task of grp.tasks) {
            listEl.child(this.renderTaskCard(task, t, subtasksByParent, cx, { isDone: false }));
          }
        }
      }
    } else {
      for (const task of visible) {
        listEl.child(this.renderTaskCard(task, t, subtasksByParent, cx, { isDone: isDoneView }));
      }
    }

    return { listEl, visibleCount: visible.length };
  }

  renderUndoBanner(t, cx) {
    const item = this.store.undoItem;
    if (!item || Date.now() >= item.expiresAt) return null;
    return h_flex()
      .px(10)
      .py(6)
      .gap(8)
      .flex_none()
      .items_center()
      .bg(t.surface)
      .border_t(1)
      .border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(`Completed "${item.task.content}"`))
      .child(
        div()
          .id("td-undo-btn")
          .px(8)
          .py(2)
          .rounded(5)
          .cursor_pointer()
          .bg(t.accent)
          .text_size(11)
          .font_medium()
          .text_color(t.background)
          .on_click((_e, cx) => {
            cx.spawn(async () => {
              await this.store.reopenTask(item.task);
            });
          })
          .child("Undo")
      );
  }

  render(cx) {
    this.store.trackFocusedTerminal();

    // React to Alt+T focus request from tabs-edited
    const focusReq = Number(shared("todoist.focusQuickAdd") || 0);
    if (focusReq && focusReq !== this.lastFocusReq && !this.isTabMode) {
      this.lastFocusReq = focusReq;
      this.managingProjects = false;
      if (this.activeView === "done") this.activeView = "all";
      selectDetailTask(this, null, null);
      this.addInput.focus();
    }

    const t = theme();
    const store = this.store;
    const selectedTask = this.getSelectedTask();

    // --- WIDE 3-COLUMN TAB MODE ---
    if (this.isTabMode) {
      const { listEl, visibleCount } = this.renderTaskList(t, cx);
      const undo = this.renderUndoBanner(t, cx);
      return h_flex()
        .id("todoist-hub-tab")
        .size_full()
        .min_h(0)
        .bg(t.background)
        .text_color(t.foreground)
        .text_size(13)
        .child(this.renderLeftSidebar(t, cx))
        // Center column
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .h_full()
            .border_r(1)
            .border_color(t.border)
            .child(this.renderHeader(t, visibleCount, cx))
            .when(this.searchOpen, (el) =>
              el.child(
                h_flex()
                  .px(10)
                  .py(6)
                  .flex_none()
                  .border_b(1)
                  .border_color(t.border)
                  .child(
                    Input.new(this.searchInput)
                      .flex_1()
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
            .when(Boolean(store.token) && this.activeView !== "done", (el) => el.child(this.renderQuickAdd(t, cx)))
            .child(listEl)
            .when(Boolean(undo), (el) => el.child(undo))
        )
        // Right inspector column
        .child(
          v_flex()
            .w(380)
            .flex_none()
            .h_full()
            .min_h(0)
            .child(
              this.managingProjects
                ? renderProjectsManager(this, t, cx)
                : renderTaskDetail(this, selectedTask, t, cx, { showBack: false })
            )
        );
    }

    // --- COMPACT RIGHT-PANEL MODE ---
    const frame = v_flex()
      .id("todoist")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13);

    if (this.managingProjects) {
      return frame.child(renderProjectsManager(this, t, cx));
    }

    if (selectedTask) {
      return frame.child(renderTaskDetail(this, selectedTask, t, cx, { showBack: true }));
    }

    const { listEl, visibleCount } = this.renderTaskList(t, cx);
    const undo = this.renderUndoBanner(t, cx);

    return frame
      .child(this.renderHeader(t, visibleCount, cx))
      .when(Boolean(store.token), (el) => el.child(this.renderProjectStrip(t, cx)))
      .when(this.searchOpen, (el) =>
        el.child(
          h_flex()
            .px(10)
            .py(6)
            .flex_none()
            .border_b(1)
            .border_color(t.border)
            .child(
              Input.new(this.searchInput)
                .flex_1()
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
      .when(Boolean(store.token) && this.activeView !== "done", (el) => el.child(this.renderQuickAdd(t, cx)))
      .child(listEl)
      .when(Boolean(undo), (el) => el.child(undo));
  }
}
