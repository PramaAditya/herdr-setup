// Pure formatting, color, date, sorting, filtering, and Markdown helpers for Todoist Hub.

export const TODOIST_COLORS = {
  berry_red: "#b8255f",
  red: "#db4035",
  orange: "#ff9933",
  yellow: "#fad000",
  olive_green: "#afb83b",
  lime_green: "#7ecc49",
  green: "#299438",
  mint_green: "#6accbc",
  teal: "#158fad",
  sky_blue: "#14aaf5",
  light_blue: "#96c3eb",
  blue: "#4073ff",
  grape: "#884dff",
  violet: "#af38eb",
  lavender: "#eb96eb",
  magenta: "#e05194",
  salmon: "#ff8d85",
  charcoal: "#808080",
  grey: "#b8b8b8",
  taupe: "#ccac93",
};

export const COLOR_SWATCHES = [
  "charcoal",
  "blue",
  "teal",
  "green",
  "orange",
  "red",
  "berry_red",
  "grape",
  "violet",
  "yellow",
  "sky_blue",
  "magenta",
];

export function todoistColor(name, fallback = "#808080") {
  if (!name) return fallback;
  if (typeof name === "string" && name.startsWith("#")) return name;
  return TODOIST_COLORS[name] ?? fallback;
}

export const PRIORITIES = [
  { value: 4, label: "P1", title: "Priority 1 (Urgent)", colorKey: "blocked" },
  { value: 3, label: "P2", title: "Priority 2 (High)", colorKey: "working" },
  { value: 2, label: "P3", title: "Priority 3 (Medium)", colorKey: "accent" },
  { value: 1, label: "P4", title: "Priority 4 (Normal)", colorKey: "dim" },
];

export function priorityColor(priority, theme) {
  if (priority === 4) return theme.blocked;
  if (priority === 3) return theme.working;
  if (priority === 2) return theme.accent;
  return theme.dim;
}

export const SORT_MODES = [
  { id: "newest", label: "Newest" },
  { id: "priority", label: "Priority" },
  { id: "due", label: "Due" },
  { id: "order", label: "Order" },
];

export function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function extractDateKey(due) {
  if (!due) return null;
  const raw = due.date || due.datetime || "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return m ? m[1] : null;
}

export function dueStatus(due, now = new Date()) {
  if (!due) return { kind: "none", label: "", dateKey: null };
  const dateKey = extractDateKey(due);
  const label = due.string || dateKey || "";
  if (!dateKey) return { kind: "upcoming", label, dateKey: null };

  const today = localDateKey(now);
  const tomorrow = localDateKey(new Date(now.getTime() + 86400 * 1000));

  if (dateKey < today) return { kind: "overdue", label, dateKey };
  if (dateKey === today) {
    // Check datetime if present
    if (due.datetime || (due.date && due.date.includes("T"))) {
      const ts = Date.parse(due.datetime || due.date);
      if (Number.isFinite(ts) && ts < now.getTime()) {
        return { kind: "overdue", label, dateKey };
      }
    }
    return { kind: "today", label, dateKey };
  }
  if (dateKey === tomorrow) return { kind: "tomorrow", label, dateKey };
  return { kind: "upcoming", label, dateKey };
}

export function isTodayOrOverdue(task, now = new Date()) {
  const st = dueStatus(task?.due, now);
  return st.kind === "today" || st.kind === "overdue";
}

export function formatRelativeTime(iso, nowMs = Date.now()) {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 60) return "just now";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 14) return `${days}d ago`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function taskTimestamp(task) {
  return Date.parse(task?.added_at || task?.created_at || "") || 0;
}

export function sortTasks(tasks, mode = "newest") {
  const list = [...tasks];
  if (mode === "priority") {
    list.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1) || taskTimestamp(b) - taskTimestamp(a));
  } else if (mode === "due") {
    list.sort((a, b) => {
      const da = extractDateKey(a.due) || "9999-99-99";
      const db = extractDateKey(b.due) || "9999-99-99";
      if (da !== db) return da.localeCompare(db);
      return (b.priority ?? 1) - (a.priority ?? 1) || taskTimestamp(b) - taskTimestamp(a);
    });
  } else if (mode === "order") {
    list.sort((a, b) => (a.child_order ?? a.order ?? 0) - (b.child_order ?? b.order ?? 0) || taskTimestamp(b) - taskTimestamp(a));
  } else {
    list.sort((a, b) => taskTimestamp(b) - taskTimestamp(a));
  }
  return list;
}

export function buildSubtaskMap(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!t.parent_id) continue;
    let arr = map.get(t.parent_id);
    if (!arr) {
      arr = [];
      map.set(t.parent_id, arr);
    }
    arr.push(t);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.child_order ?? a.order ?? 0) - (b.child_order ?? b.order ?? 0) || taskTimestamp(a) - taskTimestamp(b));
  }
  return map;
}

export function sortProjects(projects) {
  return [...projects].sort((a, b) => {
    const aInbox = Boolean(a.inbox_project || a.is_inbox_project);
    const bInbox = Boolean(b.inbox_project || b.is_inbox_project);
    if (aInbox !== bInbox) return aInbox ? -1 : 1;
    if (Boolean(a.is_favorite) !== Boolean(b.is_favorite)) return a.is_favorite ? -1 : 1;
    return (a.child_order ?? a.order ?? 0) - (b.child_order ?? b.order ?? 0) || String(a.name).localeCompare(String(b.name));
  });
}

export function filterTasksForView(tasks, { view, projectId, labelName, search, inboxId, projectById }, now = new Date()) {
  const q = String(search ?? "").trim().toLowerCase();
  const subtasksByParent = buildSubtaskMap(tasks);

  // Filter top-level tasks (or matching subtasks when searching)
  let list = tasks.filter((t) => {
    if (t.parent_id) return false;
    if (view === "inbox") {
      if (inboxId && t.project_id !== inboxId) return false;
    } else if (view === "today") {
      if (!isTodayOrOverdue(t, now)) return false;
    } else if (view === "project") {
      if (projectId && t.project_id !== projectId) return false;
    } else if (view === "label") {
      if (labelName && !(t.labels || []).includes(labelName)) return false;
    }
    if (!q) return true;

    const projName = projectById?.get(t.project_id)?.name ?? "";
    const hay = `${t.content || ""}\n${t.description || ""}\n${(t.labels || []).join(" ")}\n${projName}`.toLowerCase();
    if (hay.includes(q)) return true;

    const subs = subtasksByParent.get(t.id) ?? [];
    return subs.some((s) => `${s.content || ""}\n${s.description || ""}`.toLowerCase().includes(q));
  });

  return list;
}

export function groupBySections(tasks, sections) {
  const ordered = [...sections].sort((a, b) => (a.section_order ?? a.order ?? 0) - (b.section_order ?? b.order ?? 0));
  const groups = [];
  const unsectioned = tasks.filter((t) => !t.section_id);
  if (unsectioned.length > 0 || ordered.length === 0) {
    groups.push({ id: null, name: null, tasks: unsectioned });
  }
  const knownIds = new Set(ordered.map((s) => s.id));
  for (const sec of ordered) {
    groups.push({
      id: sec.id,
      name: sec.name,
      section: sec,
      tasks: tasks.filter((t) => t.section_id === sec.id),
    });
  }
  const orphaned = tasks.filter((t) => t.section_id && !knownIds.has(t.section_id));
  if (orphaned.length > 0) {
    groups[0].tasks.push(...orphaned);
  }
  return groups;
}

export function formatTaskMarkdown(task, { projectName, subtasks = [], comments = [] } = {}) {
  if (!task) return "";
  const parts = [task.content || ""];
  if (task.description?.trim()) {
    parts.push(task.description.trim());
  }
  if (subtasks.length > 0) {
    const lines = subtasks.map((s) => `- [${s.checked ? "x" : " "}] ${s.content}`);
    parts.push(`Subtasks:\n${lines.join("\n")}`);
  }
  if (comments.length > 0) {
    const lines = comments.map((c) => `- ${c.content}`);
    parts.push(`Notes:\n${lines.join("\n")}`);
  }
  const meta = [];
  if (projectName) meta.push(`#${projectName}`);
  if (task.labels?.length) meta.push(task.labels.map((l) => `@${l}`).join(" "));
  if (task.due?.string) meta.push(`due: ${task.due.string}`);
  if (meta.length > 0 && (subtasks.length > 0 || comments.length > 0)) {
    parts.push(`(${meta.join(" · ")})`);
  }
  return parts.filter(Boolean).join("\n\n");
}
