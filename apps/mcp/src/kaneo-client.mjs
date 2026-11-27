export class KaneoApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, body?: unknown }} [details]
   */
  constructor(message, { status = 500, code = "UPSTREAM_ERROR", body = null } = {}) {
    super(message);
    this.name = "KaneoApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Typed HTTP client for Kaneo's /api/* REST API (v2.50.0).
 * Authenticates via Authorization: Bearer <KANEO_API_KEY>.
 */
export function createKaneoClient({ baseUrl, apiKey = "", fetchImpl = fetch }) {
  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");

  async function request(method, path, { body, auth = true } = {}) {
    const headers = {};
    if (auth) {
      if (!apiKey) {
        throw new KaneoApiError("KANEO_API_KEY is not configured", {
          status: 401,
          code: "KANEO_AUTH_NOT_CONFIGURED",
        });
      }
      headers.Authorization = `Bearer ${apiKey}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetchImpl(`${normalizedBase}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const payload = await parseResponseBody(res);
    if (!res.ok) {
      const code =
        res.status === 404
          ? "NOT_FOUND"
          : res.status === 403
            ? "UPSTREAM_FORBIDDEN"
            : res.status === 409
              ? "CONFLICT"
              : "UPSTREAM_ERROR";
      throw new KaneoApiError(
        payload?.message || payload?.error || `Kaneo API ${method} ${path} failed with ${res.status}`,
        { status: res.status, code, body: payload },
      );
    }

    return payload;
  }

  return {
    health: () => request("GET", "/health", { auth: false }),
    listProjects: (workspaceId) =>
      request("GET", `/project?workspaceId=${encodeURIComponent(workspaceId)}`),
    getProject: (projectId) =>
      request("GET", `/project/${encodeURIComponent(projectId)}`),
    listColumns: (projectId) =>
      request("GET", `/column/${encodeURIComponent(projectId)}`),
    listProjectTasks: (projectId, { status, priority, page, limit } = {}) => {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (priority) qs.set("priority", priority);
      if (page !== undefined) qs.set("page", String(page));
      if (limit !== undefined) qs.set("limit", String(limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request("GET", `/task/tasks/${encodeURIComponent(projectId)}${suffix}`);
    },
    getTask: (taskId) =>
      request("GET", `/task/${encodeURIComponent(taskId)}`),
    createTask: (projectId, payload) =>
      request("POST", `/task/${encodeURIComponent(projectId)}`, { body: payload }),
    updateTask: (taskId, payload) =>
      request("PUT", `/task/${encodeURIComponent(taskId)}`, { body: payload }),
    listWorkspaceLabels: (workspaceId) =>
      request("GET", `/label/workspace/${encodeURIComponent(workspaceId)}`),
    listTaskLabels: (taskId) =>
      request("GET", `/label/task/${encodeURIComponent(taskId)}`),
    attachLabelToTask: (labelId, taskId) =>
      request("PUT", `/label/${encodeURIComponent(labelId)}/task`, { body: { taskId } }),
    listTaskRelations: (taskId) =>
      request("GET", `/task-relation/${encodeURIComponent(taskId)}`),
    createTaskRelation: (payload) =>
      request("POST", "/task-relation", { body: payload }),
  };
}
