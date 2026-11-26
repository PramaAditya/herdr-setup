// Shared singleton store across Todoist right-panel and popped-out Hub tab instances.
import { checking, focused, panes, setShared, window } from "herdr";
import * as api from "./api.js";
import { sortProjects } from "./format.js";

const STORE_KEY = Symbol.for("herdr.todoist.hub.v1");

class TodoistStore {
  constructor() {
    this.token = null;
    this.loading = true;
    this.error = null;
    this.lastSyncAt = 0;

    this.tasks = [];
    this.projects = [];
    this.archivedProjects = [];
    this.archivedLoaded = false;
    this.sections = [];
    this.labels = [];

    this.completedTasks = [];
    this.completedLoaded = false;
    this.completedLoading = false;

    this.commentsByTask = new Map();
    this.commentsLoading = new Set();

    this.closing = new Set();
    this.undoItem = null; // { task, expiresAt }
    this.lastTerminalPane = null;

    this.listeners = new Set();
    this._inFlight = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(bumpShared = true) {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // ignore disposed view listener
      }
    }
    if (bumpShared) {
      try {
        setShared("todoist.rev", Date.now());
      } catch {
        // ignore during check
      }
    }
  }

  trackFocusedTerminal() {
    try {
      const f = focused();
      if (f?.pane && f?.terminal) {
        this.lastTerminalPane = f.pane;
        return;
      }
      if (!this.lastTerminalPane) {
        const anyTerm = panes().find((p) => p.terminal);
        if (anyTerm) this.lastTerminalPane = anyTerm.pane;
      }
    } catch {
      // ignore
    }
  }

  get inboxProject() {
    return this.projects.find((p) => p.inbox_project || p.is_inbox_project) ?? this.projects[0] ?? null;
  }

  get projectById() {
    return new Map(this.projects.map((p) => [p.id, p]));
  }

  get sectionById() {
    return new Map(this.sections.map((s) => [s.id, s]));
  }

  sectionsForProject(projectId) {
    return this.sections
      .filter((s) => s.project_id === projectId)
      .sort((a, b) => (a.section_order ?? a.order ?? 0) - (b.section_order ?? b.order ?? 0));
  }

  countForProject(projectId) {
    let n = 0;
    for (const t of this.tasks) {
      if (!t.parent_id && t.project_id === projectId) n++;
    }
    return n;
  }

  async ensureToken() {
    if (this.token) return this.token;
    const tok = await api.loadToken();
    this.token = tok;
    return tok;
  }

  async refresh(silent = false) {
    if (checking()) return;
    if (silent && window()?.visible === false) return;
    if (this._inFlight) return this._inFlight;

    if (!silent) {
      this.loading = true;
      this.error = null;
      this.emit(false);
    }

    this._inFlight = (async () => {
      try {
        const token = await api.loadToken();
        this.token = token;
        if (!token) {
          this.tasks = [];
          this.projects = [];
          this.sections = [];
          this.labels = [];
          this.error = "missing_token";
          return;
        }
        const [tasks, projects, sections, labels] = await Promise.all([
          api.listTasks(token),
          api.listProjects(token),
          api.listSections(token),
          api.listLabels(token),
        ]);
        this.tasks = tasks;
        this.projects = sortProjects(projects);
        this.sections = sections;
        this.labels = labels;
        this.lastSyncAt = Date.now();
        this.error = null;
      } catch (err) {
        this.error = String(err?.message || err || "Failed to load Todoist");
      } finally {
        this.loading = false;
        this._inFlight = null;
        this.emit();
      }
    })();

    return this._inFlight;
  }

  async loadCompleted(force = false) {
    if (checking()) return;
    if (!force && (this.completedLoaded || this.completedLoading)) return;
    const token = await this.ensureToken();
    if (!token) return;
    this.completedLoading = true;
    this.emit(false);
    try {
      const items = await api.listCompleted(token, { days: 14, limit: 100 });
      items.sort((a, b) => (Date.parse(b.completed_at || "") || 0) - (Date.parse(a.completed_at || "") || 0));
      this.completedTasks = items;
      this.completedLoaded = true;
    } catch (err) {
      this.error = String(err?.message || err || "Failed to load completed tasks");
    } finally {
      this.completedLoading = false;
      this.emit(false);
    }
  }

  async loadArchivedProjects(force = false) {
    if (!force && this.archivedLoaded) return;
    const token = await this.ensureToken();
    if (!token) return;
    try {
      this.archivedProjects = await api.listArchivedProjects(token);
      this.archivedLoaded = true;
      this.emit(false);
    } catch {
      // ignore if unsupported
    }
  }

  async loadComments(taskId, force = false) {
    if (!taskId) return;
    if (!force && (this.commentsByTask.has(taskId) || this.commentsLoading.has(taskId))) return;
    const token = await this.ensureToken();
    if (!token) return;
    this.commentsLoading.add(taskId);
    this.emit(false);
    try {
      const list = await api.listComments(token, taskId);
      this.commentsByTask.set(taskId, list);
    } catch {
      if (!this.commentsByTask.has(taskId)) this.commentsByTask.set(taskId, []);
    } finally {
      this.commentsLoading.delete(taskId);
      this.emit(false);
    }
  }

  // --- Task Mutations ---

  async addTask(text, { nlp = true, projectId = null, sectionId = null, note = "" } = {}) {
    const token = await this.ensureToken();
    const trimmed = String(text ?? "").trim();
    if (!token || !trimmed) return null;

    let created = null;
    if (nlp) {
      created = await api.quickAddTask(token, trimmed, note || undefined);
    } else {
      const body = { content: trimmed };
      if (note) body.description = note;
      if (projectId) body.project_id = projectId;
      if (sectionId) body.section_id = sectionId;
      created = await api.createTask(token, body);
    }
    if (created?.id) {
      this.tasks = [created, ...this.tasks.filter((t) => t.id !== created.id)];
      this.emit();
      // If NLP created a new label or changed project counts, refresh silently in background
      if (nlp) this.refresh(true);
    }
    return created;
  }

  async addSubtask(parentTask, content) {
    const token = await this.ensureToken();
    const trimmed = String(content ?? "").trim();
    if (!token || !parentTask?.id || !trimmed) return null;
    const created = await api.createTask(token, {
      content: trimmed,
      parent_id: parentTask.id,
      project_id: parentTask.project_id,
    });
    if (created?.id) {
      this.tasks = [...this.tasks, created];
      this.emit();
    }
    return created;
  }

  async updateTask(taskId, patch) {
    const token = await this.ensureToken();
    if (!token || !taskId) return null;
    const prev = this.tasks;
    const updated = await api.updateTask(token, taskId, patch);
    if (updated?.id) {
      this.tasks = this.tasks.map((t) => (t.id === taskId ? { ...t, ...updated } : t));
      this.emit();
    } else {
      this.tasks = prev;
    }
    return updated;
  }

  async moveTask(taskId, target) {
    const token = await this.ensureToken();
    if (!token || !taskId) return null;
    const prev = this.tasks;
    this.tasks = this.tasks.map((t) => {
      if (t.id !== taskId) return t;
      return {
        ...t,
        ...(target.project_id !== undefined ? { project_id: target.project_id } : {}),
        section_id: target.section_id !== undefined ? target.section_id : null,
        ...(target.parent_id !== undefined ? { parent_id: target.parent_id } : {}),
      };
    });
    this.emit();
    try {
      const res = await api.moveTask(token, taskId, target);
      if (res?.id) {
        this.tasks = this.tasks.map((t) => (t.id === taskId ? { ...t, ...res } : t));
      }
      this.emit();
      return res;
    } catch (err) {
      this.tasks = prev;
      this.error = String(err?.message || err);
      this.emit();
      throw err;
    }
  }

  async completeTask(task) {
    const token = await this.ensureToken();
    if (!token || !task?.id || this.closing.has(task.id)) return;
    this.closing.add(task.id);
    const prevTasks = this.tasks;
    const prevCompleted = this.completedTasks;
    const isRecurring = Boolean(task.due?.is_recurring);

    if (!isRecurring) {
      this.tasks = this.tasks.filter((t) => t.id !== task.id);
      this.completedTasks = [{ ...task, checked: true, completed_at: new Date().toISOString() }, ...this.completedTasks];
      this.undoItem = { task, expiresAt: Date.now() + 7000 };
    }
    this.emit();

    try {
      await api.closeTask(token, task.id);
      if (isRecurring) {
        await this.refresh(true);
      }
    } catch (err) {
      this.tasks = prevTasks;
      this.completedTasks = prevCompleted;
      this.undoItem = null;
      this.error = String(err?.message || err);
    } finally {
      this.closing.delete(task.id);
      this.emit();
    }
  }

  async reopenTask(task) {
    const token = await this.ensureToken();
    if (!token || !task?.id) return;
    const prevTasks = this.tasks;
    const prevCompleted = this.completedTasks;

    const restored = { ...task, checked: false, completed_at: null };
    if (!this.tasks.some((t) => t.id === task.id)) {
      this.tasks = [restored, ...this.tasks];
    }
    this.completedTasks = this.completedTasks.filter((t) => t.id !== task.id);
    if (this.undoItem?.task?.id === task.id) this.undoItem = null;
    this.emit();

    try {
      await api.reopenTask(token, task.id);
    } catch (err) {
      this.tasks = prevTasks;
      this.completedTasks = prevCompleted;
      this.error = String(err?.message || err);
      this.emit();
    }
  }

  async deleteTask(taskId) {
    const token = await this.ensureToken();
    if (!token || !taskId) return;
    const prev = this.tasks;
    this.tasks = this.tasks.filter((t) => t.id !== taskId && t.parent_id !== taskId);
    this.emit();
    try {
      await api.deleteTask(token, taskId);
    } catch (err) {
      this.tasks = prev;
      this.error = String(err?.message || err);
      this.emit();
    }
  }

  // --- Project Mutations ---

  async createProject({ name, color = "charcoal", is_favorite = false }) {
    const token = await this.ensureToken();
    if (!token || !name?.trim()) return null;
    const created = await api.createProject(token, { name: name.trim(), color, is_favorite });
    if (created?.id) {
      this.projects = sortProjects([...this.projects, created]);
      this.emit();
    }
    return created;
  }

  async updateProject(projectId, patch) {
    const token = await this.ensureToken();
    if (!token || !projectId) return null;
    const updated = await api.updateProject(token, projectId, patch);
    if (updated?.id) {
      this.projects = sortProjects(this.projects.map((p) => (p.id === projectId ? { ...p, ...updated } : p)));
      this.emit();
    }
    return updated;
  }

  async archiveProject(projectId) {
    const token = await this.ensureToken();
    if (!token || !projectId) return;
    const target = this.projects.find((p) => p.id === projectId);
    await api.archiveProject(token, projectId);
    this.projects = this.projects.filter((p) => p.id !== projectId);
    if (target) this.archivedProjects = [{ ...target, is_archived: true }, ...this.archivedProjects];
    this.tasks = this.tasks.filter((t) => t.project_id !== projectId);
    this.emit();
  }

  async unarchiveProject(projectId) {
    const token = await this.ensureToken();
    if (!token || !projectId) return;
    const target = this.archivedProjects.find((p) => p.id === projectId);
    await api.unarchiveProject(token, projectId);
    this.archivedProjects = this.archivedProjects.filter((p) => p.id !== projectId);
    if (target) this.projects = sortProjects([...this.projects, { ...target, is_archived: false }]);
    this.emit();
    await this.refresh(true);
  }

  async deleteProject(projectId) {
    const token = await this.ensureToken();
    if (!token || !projectId) return;
    await api.deleteProject(token, projectId);
    this.projects = this.projects.filter((p) => p.id !== projectId);
    this.archivedProjects = this.archivedProjects.filter((p) => p.id !== projectId);
    this.tasks = this.tasks.filter((t) => t.project_id !== projectId);
    this.sections = this.sections.filter((s) => s.project_id !== projectId);
    this.emit();
  }

  // --- Section Mutations ---

  async createSection(projectId, name) {
    const token = await this.ensureToken();
    if (!token || !projectId || !name?.trim()) return null;
    const created = await api.createSection(token, { project_id: projectId, name: name.trim() });
    if (created?.id) {
      this.sections = [...this.sections, created];
      this.emit();
    }
    return created;
  }

  async updateSection(sectionId, name) {
    const token = await this.ensureToken();
    if (!token || !sectionId || !name?.trim()) return null;
    const updated = await api.updateSection(token, sectionId, { name: name.trim() });
    if (updated?.id) {
      this.sections = this.sections.map((s) => (s.id === sectionId ? { ...s, ...updated } : s));
      this.emit();
    }
    return updated;
  }

  async deleteSection(sectionId) {
    const token = await this.ensureToken();
    if (!token || !sectionId) return;
    await api.deleteSection(token, sectionId);
    this.sections = this.sections.filter((s) => s.id !== sectionId);
    this.tasks = this.tasks.filter((t) => t.section_id !== sectionId);
    this.emit();
  }

  // --- Label Mutations ---

  async createLabel(name, color = "charcoal") {
    const token = await this.ensureToken();
    if (!token || !name?.trim()) return null;
    const created = await api.createLabel(token, { name: name.trim(), color });
    if (created?.id) {
      this.labels = [...this.labels, created];
      this.emit();
    }
    return created;
  }

  async deleteLabel(labelId) {
    const token = await this.ensureToken();
    if (!token || !labelId) return;
    const target = this.labels.find((l) => l.id === labelId);
    await api.deleteLabel(token, labelId);
    this.labels = this.labels.filter((l) => l.id !== labelId);
    if (target?.name) {
      this.tasks = this.tasks.map((t) =>
        t.labels?.includes(target.name) ? { ...t, labels: t.labels.filter((x) => x !== target.name) } : t
      );
    }
    this.emit();
  }

  // --- Comment Mutations ---

  async addComment(taskId, content) {
    const token = await this.ensureToken();
    const trimmed = String(content ?? "").trim();
    if (!token || !taskId || !trimmed) return null;
    const created = await api.createComment(token, { task_id: taskId, content: trimmed });
    if (created?.id) {
      const prev = this.commentsByTask.get(taskId) ?? [];
      this.commentsByTask.set(taskId, [...prev, created]);
      this.tasks = this.tasks.map((t) => (t.id === taskId ? { ...t, note_count: (t.note_count ?? 0) + 1 } : t));
      this.emit();
    }
    return created;
  }

  async deleteComment(taskId, commentId) {
    const token = await this.ensureToken();
    if (!token || !taskId || !commentId) return;
    await api.deleteComment(token, commentId);
    const prev = this.commentsByTask.get(taskId) ?? [];
    this.commentsByTask.set(taskId, prev.filter((c) => c.id !== commentId));
    this.tasks = this.tasks.map((t) =>
      t.id === taskId ? { ...t, note_count: Math.max(0, (t.note_count ?? 1) - 1) } : t
    );
    this.emit();
  }
}

export function getStore() {
  if (!globalThis[STORE_KEY]) {
    globalThis[STORE_KEY] = new TodoistStore();
  }
  return globalThis[STORE_KEY];
}
