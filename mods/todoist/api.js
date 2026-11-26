// Todoist Unified API v1 client (https://api.todoist.com/api/v1).
import { appHome, readTextFile } from "herdr";

export const API_BASE = "https://api.todoist.com/api/v1";

export async function loadToken() {
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

function buildUrl(path, params) {
  const base = `${API_BASE}${path}`;
  if (!params) return base;
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `${base}?${qs}` : base;
}

export async function req(token, path, { method = "GET", params, body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(buildUrl(path, params), init);
  if (!res.ok) {
    let detail = "";
    try {
      const txt = await res.text();
      if (txt) {
        try {
          const parsed = JSON.parse(txt);
          detail = parsed?.error || parsed?.message || txt.slice(0, 120);
        } catch {
          detail = txt.slice(0, 120);
        }
      }
    } catch {
      // ignore
    }
    throw new Error(detail ? `Todoist ${res.status}: ${detail}` : `Todoist API error (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

export function extractList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

export async function getAll(token, path, params = {}, maxPages = 10) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await req(token, path, {
      params: { ...params, limit: params.limit ?? 200, ...(cursor ? { cursor } : {}) },
    });
    const list = extractList(data);
    out.push(...list);
    cursor = data?.next_cursor || null;
    if (!cursor || list.length === 0) break;
  }
  return out;
}

// --- Tasks ---

export const listTasks = (token, params = {}) => getAll(token, "/tasks", params);

export const filterTasks = (token, query) => getAll(token, "/tasks/filter", { query });

export const createTask = (token, body) => req(token, "/tasks", { method: "POST", body });

export const quickAddTask = (token, text, note) =>
  req(token, "/tasks/quick", {
    method: "POST",
    body: note ? { text, note } : { text },
  });

export const updateTask = (token, taskId, body) =>
  req(token, `/tasks/${encodeURIComponent(taskId)}`, { method: "POST", body });

export const moveTask = (token, taskId, { project_id, section_id, parent_id }) => {
  const body = {};
  if (parent_id) body.parent_id = parent_id;
  else if (section_id) body.section_id = section_id;
  else if (project_id) body.project_id = project_id;
  return req(token, `/tasks/${encodeURIComponent(taskId)}/move`, { method: "POST", body });
};

export const closeTask = (token, taskId) =>
  req(token, `/tasks/${encodeURIComponent(taskId)}/close`, { method: "POST" });

export const reopenTask = (token, taskId) =>
  req(token, `/tasks/${encodeURIComponent(taskId)}/reopen`, { method: "POST" });

export const deleteTask = (token, taskId) =>
  req(token, `/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });

export function listCompleted(token, { days = 14, project_id, limit = 100 } = {}) {
  const until = new Date();
  const since = new Date(until.getTime() - days * 86400 * 1000);
  return getAll(
    token,
    "/tasks/completed/by_completion_date",
    {
      since: since.toISOString(),
      until: until.toISOString(),
      ...(project_id ? { project_id } : {}),
      limit,
    },
    3
  );
}

// --- Projects ---

export const listProjects = (token) => getAll(token, "/projects");

export const listArchivedProjects = (token) => getAll(token, "/projects/archived", {}, 5);

export const createProject = (token, body) => req(token, "/projects", { method: "POST", body });

export const updateProject = (token, projectId, body) =>
  req(token, `/projects/${encodeURIComponent(projectId)}`, { method: "POST", body });

export const archiveProject = (token, projectId) =>
  req(token, `/projects/${encodeURIComponent(projectId)}/archive`, { method: "POST" });

export const unarchiveProject = (token, projectId) =>
  req(token, `/projects/${encodeURIComponent(projectId)}/unarchive`, { method: "POST" });

export const deleteProject = (token, projectId) =>
  req(token, `/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });

// --- Sections ---

export const listSections = (token, projectId) =>
  getAll(token, "/sections", projectId ? { project_id: projectId } : {});

export const createSection = (token, body) => req(token, "/sections", { method: "POST", body });

export const updateSection = (token, sectionId, body) =>
  req(token, `/sections/${encodeURIComponent(sectionId)}`, { method: "POST", body });

export const deleteSection = (token, sectionId) =>
  req(token, `/sections/${encodeURIComponent(sectionId)}`, { method: "DELETE" });

// --- Labels ---

export const listLabels = (token) => getAll(token, "/labels");

export const createLabel = (token, body) => req(token, "/labels", { method: "POST", body });

export const updateLabel = (token, labelId, body) =>
  req(token, `/labels/${encodeURIComponent(labelId)}`, { method: "POST", body });

export const deleteLabel = (token, labelId) =>
  req(token, `/labels/${encodeURIComponent(labelId)}`, { method: "DELETE" });

// --- Comments ---

export const listComments = (token, taskId) => getAll(token, "/comments", { task_id: taskId }, 5);

export const createComment = (token, { task_id, content }) =>
  req(token, "/comments", { method: "POST", body: { task_id, content } });

export const updateComment = (token, commentId, content) =>
  req(token, `/comments/${encodeURIComponent(commentId)}`, { method: "POST", body: { content } });

export const deleteComment = (token, commentId) =>
  req(token, `/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
