import crypto from "node:crypto";
import Fastify from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { parseMcpTokens } from "./config.mjs";
import { createConfirmStore } from "./confirm-store.mjs";

const PRIORITY_ENUM = z.enum(["no-priority", "low", "medium", "high", "urgent"]);
const RELATIONSHIP_ENUM = z.enum(["subtask", "blocks", "blocking", "related"]);

function normalizeRelationType(type) {
  return type === "blocking" ? "blocks" : type;
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function toolError(code, details = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, ...details }) }],
  };
}

function toolOk(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function isProjectAllowed(scope, project) {
  if (!scope || !project) return false;
  if (project.workspaceId !== scope.allowedWorkspaceId) return false;
  if (scope.allowedProjects.includes("*")) return true;
  return scope.allowedProjects.includes(project.id);
}

function normalizeUpstreamError(error, context = {}) {
  if (error?.status === 404 || error?.code === "NOT_FOUND") {
    return { ok: false, error: toolError("NOT_FOUND", { message: error.message, ...context }) };
  }
  if (error?.status === 403 || error?.code === "UPSTREAM_FORBIDDEN") {
    return { ok: false, error: toolError("FORBIDDEN_DOMAIN", { message: error.message, ...context }) };
  }
  return { ok: false, error: toolError("UPSTREAM_ERROR", { message: error?.message || "Upstream error", ...context }) };
}

async function resolveAuthorizedProject(kaneoClient, scope, projectId) {
  let project;
  try {
    project = await kaneoClient.getProject(projectId);
  } catch (error) {
    return normalizeUpstreamError(error, { projectId });
  }
  if (!isProjectAllowed(scope, project)) {
    return { ok: false, error: toolError("FORBIDDEN_DOMAIN", { projectId }) };
  }
  return { ok: true, project };
}

async function resolveAuthorizedTask(kaneoClient, scope, taskId) {
  let task;
  try {
    task = await kaneoClient.getTask(taskId);
  } catch (error) {
    return normalizeUpstreamError(error, { taskId });
  }
  const projectRes = await resolveAuthorizedProject(kaneoClient, scope, task.projectId);
  if (!projectRes.ok) {
    return {
      ok: false,
      error: projectRes.error.content[0].text.includes("FORBIDDEN_DOMAIN")
        ? toolError("FORBIDDEN_DOMAIN", { issueId: taskId, projectId: task.projectId })
        : projectRes.error,
    };
  }
  return { ok: true, task, project: projectRes.project };
}

async function resolveColumnSlug(kaneoClient, projectId, { status, requireDefault = false }) {
  const raw = await kaneoClient.listColumns(projectId);
  const columns = Array.isArray(raw) ? raw : [];

  if (status) {
    const needle = status.trim().toLowerCase();
    const match = columns.find(
      (col) =>
        String(col.slug || "").toLowerCase() === needle ||
        String(col.name || "").trim().toLowerCase() === needle,
    );
    if (!match) {
      return {
        ok: false,
        error: toolError("STATUS_NOT_FOUND", {
          projectId,
          status,
          available: columns.map((c) => ({ slug: c.slug, name: c.name })),
        }),
      };
    }
    return { ok: true, column: match, columns };
  }

  if (!requireDefault) {
    return { ok: true, column: null, columns };
  }

  const ordered = [...columns].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const preferred =
    ordered.find((c) => /^(to-?do|backlog|planned)$/i.test(String(c.slug || "").trim())) ||
    ordered.find((c) => /^(to\s*do|backlog|planned)$/i.test(String(c.name || "").trim())) ||
    ordered[0];

  if (!preferred) {
    return { ok: false, error: toolError("NO_PROJECT_COLUMNS", { projectId }) };
  }
  return { ok: true, column: preferred, columns };
}

async function resolveWorkspaceLabels(kaneoClient, workspaceId, requestedLabels = []) {
  if (!requestedLabels.length) return { ok: true, resolved: [] };
  const raw = await kaneoClient.listWorkspaceLabels(workspaceId);
  const workspaceLabels = Array.isArray(raw) ? raw : [];
  const resolved = [];
  const seen = new Set();

  for (const item of requestedLabels) {
    const needle = String(item).trim();
    const match = workspaceLabels.find(
      (lbl) => lbl.id === needle || String(lbl.name || "").trim().toLowerCase() === needle.toLowerCase(),
    );
    if (!match) {
      return {
        ok: false,
        error: toolError("TAG_NOT_FOUND", {
          workspaceId,
          tag: needle,
          available: workspaceLabels.map((l) => ({ id: l.id, name: l.name })),
        }),
      };
    }
    if (!seen.has(match.id)) {
      seen.add(match.id);
      resolved.push(match);
    }
  }
  return { ok: true, resolved };
}

function flattenBoardTasks(boardResponse) {
  const board = boardResponse?.data;
  if (!board) return [];
  const tasks = [];
  for (const col of board.columns ?? []) {
    for (const task of col.tasks ?? []) {
      tasks.push(task);
    }
  }
  for (const task of board.plannedTasks ?? []) {
    tasks.push(task);
  }
  return tasks;
}

function createScopedMcpServer({ kaneoClient, scope, confirmStore }) {
  const server = new McpServer({
    name: "kanban-mcp",
    version: "0.2.0",
  });

  server.registerTool(
    "list_projects",
    {
      description: "Lista projetos e colunas autorizados para o workspace/domínio deste profile Hermes no Kaneo.",
      inputSchema: {
        include_columns: z.boolean().optional(),
        include_labels: z.boolean().optional(),
      },
    },
    async ({ include_columns = true, include_labels = false }) => {
      let data;
      try {
        data = await kaneoClient.listProjects(scope.allowedWorkspaceId);
      } catch (error) {
        return normalizeUpstreamError(error, { workspaceId: scope.allowedWorkspaceId }).error;
      }

      const rawProjects = Array.isArray(data) ? data : [];
      const authorized = rawProjects.filter((project) => isProjectAllowed(scope, project));

      let workspaceLabels = null;
      if (include_labels) {
        try {
          const labels = await kaneoClient.listWorkspaceLabels(scope.allowedWorkspaceId);
          workspaceLabels = Array.isArray(labels) ? labels : [];
        } catch (error) {
          return normalizeUpstreamError(error, { workspaceId: scope.allowedWorkspaceId }).error;
        }
      }

      const projects = await Promise.all(
        authorized.map(async (project) => {
          const item = { ...project };
          if (include_columns) {
            const cols = await kaneoClient.listColumns(project.id);
            item.columns = Array.isArray(cols) ? cols : [];
          }
          return item;
        }),
      );

      return toolOk({
        profile: scope.profile,
        domainId: scope.domainId,
        allowedWorkspaceId: scope.allowedWorkspaceId,
        projects,
        ...(workspaceLabels ? { labels: workspaceLabels } : {}),
      });
    },
  );

  server.registerTool(
    "list_issues",
    {
      description: "Lista ou filtra tasks de um projeto autorizado no Kaneo.",
      inputSchema: {
        project_id: z.string().min(1),
        status: z.string().min(1).optional(),
        priority: PRIORITY_ENUM.optional(),
        search: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ project_id, status, priority, search, limit, page }) => {
      const projectCheck = await resolveAuthorizedProject(kaneoClient, scope, project_id);
      if (!projectCheck.ok) return projectCheck.error;

      try {
        const result = await kaneoClient.listProjectTasks(project_id, {
          status,
          priority,
          limit: limit ?? 50,
          page: page ?? 1,
        });
        let issues = flattenBoardTasks(result);
        if (search) {
          const needle = search.trim().toLowerCase();
          issues = issues.filter(
            (t) =>
              String(t.title || "").toLowerCase().includes(needle) ||
              String(t.description || "").toLowerCase().includes(needle),
          );
        }

        return toolOk({
          profile: scope.profile,
          project: { id: projectCheck.project.id, name: projectCheck.project.name, slug: projectCheck.project.slug },
          issues,
          pagination: result?.pagination ?? null,
        });
      } catch (error) {
        return normalizeUpstreamError(error, { projectId: project_id }).error;
      }
    },
  );

  server.registerTool(
    "get_issue_details",
    {
      description: "Lê detalhes completos de uma task autorizada no Kaneo, incluindo coluna, labels e relacionamentos.",
      inputSchema: {
        issue_id: z.string().min(1),
      },
    },
    async ({ issue_id }) => {
      const taskCheck = await resolveAuthorizedTask(kaneoClient, scope, issue_id);
      if (!taskCheck.ok) return taskCheck.error;

      try {
        const [columns, labels, relations] = await Promise.all([
          kaneoClient.listColumns(taskCheck.project.id),
          kaneoClient.listTaskLabels(issue_id),
          kaneoClient.listTaskRelations(issue_id),
        ]);
        const columnList = Array.isArray(columns) ? columns : [];

        return toolOk({
          issue: taskCheck.task,
          column: columnList.find((c) => c.slug === taskCheck.task.status) ?? null,
          project: taskCheck.project,
          labels: Array.isArray(labels) ? labels : [],
          relationships: Array.isArray(relations) ? relations : [],
        });
      } catch (error) {
        return normalizeUpstreamError(error, { issueId: issue_id }).error;
      }
    },
  );

  server.registerTool(
    "propose_create_issue",
    {
      description:
        "Etapa 1/2: valida escopo e prepara criação de task no Kaneo (prioridade, labels e parent_issue_id), gerando confirm_token (TTL 5 min).",
      inputSchema: {
        project_id: z.string().min(1),
        title: z.string().min(1).max(500),
        description: z.string().default(""),
        priority: PRIORITY_ENUM.default("no-priority"),
        status: z.string().min(1).optional(),
        tags: z.array(z.string().min(1)).default([]),
        parent_issue_id: z.string().min(1).optional(),
        start_date: z.string().min(1).optional(),
        due_date: z.string().min(1).optional(),
      },
    },
    async ({ project_id, title, description, priority, status, tags, parent_issue_id, start_date, due_date }) => {
      const projectCheck = await resolveAuthorizedProject(kaneoClient, scope, project_id);
      if (!projectCheck.ok) return projectCheck.error;

      if (parent_issue_id) {
        const parentCheck = await resolveAuthorizedTask(kaneoClient, scope, parent_issue_id);
        if (!parentCheck.ok) return parentCheck.error;
      }

      const colRes = await resolveColumnSlug(kaneoClient, project_id, {
        status,
        requireDefault: true,
      });
      if (!colRes.ok) return colRes.error;

      const labelsRes = await resolveWorkspaceLabels(kaneoClient, scope.allowedWorkspaceId, tags);
      if (!labelsRes.ok) return labelsRes.error;

      const params = {
        project_id,
        title: title.trim(),
        description,
        priority,
        status: colRes.column.slug,
        start_date,
        due_date,
        parent_issue_id: parent_issue_id ?? null,
        label_ids: labelsRes.resolved.map((l) => l.id),
      };

      const proposal = confirmStore.propose({
        scope,
        action: "create_issue",
        params,
        preview: {
          project: { id: projectCheck.project.id, name: projectCheck.project.name, slug: projectCheck.project.slug },
          column: { slug: colRes.column.slug, name: colRes.column.name },
          title: params.title,
          priority: params.priority,
          parent_issue_id: params.parent_issue_id,
          labels: labelsRes.resolved.map((l) => ({ id: l.id, name: l.name })),
        },
      });

      return toolOk(proposal);
    },
  );

  server.registerTool(
    "propose_update_issue",
    {
      description: "Etapa 1/2: valida escopo e prepara atualização de uma task existente no Kaneo, gerando confirm_token (TTL 5 min).",
      inputSchema: {
        issue_id: z.string().min(1),
        title: z.string().min(1).max(500).optional(),
        description: z.string().optional(),
        status: z.string().min(1).optional(),
        priority: PRIORITY_ENUM.optional(),
        start_date: z.string().min(1).optional(),
        due_date: z.string().min(1).optional(),
      },
    },
    async ({ issue_id, title, description, status, priority, start_date, due_date }) => {
      const taskCheck = await resolveAuthorizedTask(kaneoClient, scope, issue_id);
      if (!taskCheck.ok) return taskCheck.error;

      const colRes = await resolveColumnSlug(kaneoClient, taskCheck.project.id, {
        status,
        requireDefault: false,
      });
      if (!colRes.ok) return colRes.error;

      const patch = {};
      if (title !== undefined) patch.title = title.trim();
      if (description !== undefined) patch.description = description;
      if (colRes.column) patch.status = colRes.column.slug;
      if (priority !== undefined) patch.priority = priority;
      if (start_date !== undefined) patch.startDate = start_date;
      if (due_date !== undefined) patch.dueDate = due_date;

      if (Object.keys(patch).length === 0) {
        return toolError("EMPTY_UPDATE", { issueId: issue_id });
      }

      const proposal = confirmStore.propose({
        scope,
        action: "update_issue",
        params: { issue_id, project_id: taskCheck.project.id, patch },
        preview: {
          issue_id,
          number: taskCheck.task.number,
          current_title: taskCheck.task.title,
          patch,
        },
      });

      return toolOk(proposal);
    },
  );

  server.registerTool(
    "propose_add_issue_tag",
    {
      description: "Etapa 1/2: valida escopo e prepara associação de uma label do workspace à task, gerando confirm_token (TTL 5 min).",
      inputSchema: {
        issue_id: z.string().min(1),
        tag_id: z.string().min(1).optional(),
        tag_name: z.string().min(1).optional(),
      },
    },
    async ({ issue_id, tag_id, tag_name }) => {
      if (!tag_id && !tag_name) {
        return toolError("VALIDATION_ERROR", { message: "Provide either tag_id or tag_name." });
      }
      const taskCheck = await resolveAuthorizedTask(kaneoClient, scope, issue_id);
      if (!taskCheck.ok) return taskCheck.error;

      const labelsRes = await resolveWorkspaceLabels(kaneoClient, scope.allowedWorkspaceId, [tag_id || tag_name]);
      if (!labelsRes.ok) return labelsRes.error;
      const resolvedLabel = labelsRes.resolved[0];

      const proposal = confirmStore.propose({
        scope,
        action: "add_issue_tag",
        params: { issue_id, project_id: taskCheck.project.id, label_id: resolvedLabel.id },
        preview: {
          issue_id,
          title: taskCheck.task.title,
          label: { id: resolvedLabel.id, name: resolvedLabel.name },
        },
      });

      return toolOk(proposal);
    },
  );

  server.registerTool(
    "propose_link_issue_relationship",
    {
      description:
        "Etapa 1/2: valida escopo de ambas as tasks e prepara vínculo (subtask, blocks/blocking, related), gerando confirm_token (TTL 5 min).",
      inputSchema: {
        issue_id: z.string().min(1),
        related_issue_id: z.string().min(1),
        relationship_type: RELATIONSHIP_ENUM,
      },
    },
    async ({ issue_id, related_issue_id, relationship_type }) => {
      if (issue_id === related_issue_id) {
        return toolError("VALIDATION_ERROR", { message: "issue_id and related_issue_id must differ." });
      }
      const sourceCheck = await resolveAuthorizedTask(kaneoClient, scope, issue_id);
      if (!sourceCheck.ok) return sourceCheck.error;

      const targetCheck = await resolveAuthorizedTask(kaneoClient, scope, related_issue_id);
      if (!targetCheck.ok) return targetCheck.error;

      const normalizedType = normalizeRelationType(relationship_type);
      const proposal = confirmStore.propose({
        scope,
        action: "link_issue_relationship",
        params: {
          source_task_id: issue_id,
          target_task_id: related_issue_id,
          relation_type: normalizedType,
          project_id: sourceCheck.project.id,
          related_project_id: targetCheck.project.id,
        },
        preview: {
          issue: { id: sourceCheck.task.id, title: sourceCheck.task.title },
          related_issue: { id: targetCheck.task.id, title: targetCheck.task.title },
          relation_type: normalizedType,
        },
      });

      return toolOk(proposal);
    },
  );

  server.registerTool(
    "apply_kanban_mutation",
    {
      description: "Etapa 2/2: consome o confirm_token emitido pela etapa propose_* e executa a mutação no Kaneo.",
      inputSchema: {
        confirm_token: z.string().min(1),
        params_hash: z.string().min(1).optional(),
      },
    },
    async ({ confirm_token, params_hash }) => {
      const consumed = confirmStore.consume({
        token: confirm_token,
        scope,
        expectedParamsHash: params_hash,
      });
      if (!consumed.ok) {
        return toolError(consumed.error, { message: consumed.message });
      }

      const { action, params } = consumed.entry;

      try {
        if (action === "create_issue") {
          const projectCheck = await resolveAuthorizedProject(kaneoClient, scope, params.project_id);
          if (!projectCheck.ok) return projectCheck.error;

          const created = await kaneoClient.createTask(params.project_id, {
            title: params.title,
            description: params.description,
            priority: params.priority,
            status: params.status,
            ...(params.start_date ? { startDate: params.start_date } : {}),
            ...(params.due_date ? { dueDate: params.due_date } : {}),
          });

          const attachedLabels = [];
          for (const labelId of params.label_ids ?? []) {
            await kaneoClient.attachLabelToTask(labelId, created.id);
            attachedLabels.push(labelId);
          }

          let parentRelation = null;
          if (params.parent_issue_id) {
            const parentCheck = await resolveAuthorizedTask(kaneoClient, scope, params.parent_issue_id);
            if (!parentCheck.ok) return parentCheck.error;
            parentRelation = await kaneoClient.createTaskRelation({
              sourceTaskId: params.parent_issue_id,
              targetTaskId: created.id,
              relationType: "subtask",
            });
          }

          return toolOk({
            ok: true,
            action,
            applied_by_profile: scope.profile,
            issue: created,
            attached_label_ids: attachedLabels,
            parent_relation: parentRelation,
          });
        }

        if (action === "update_issue") {
          const taskCheck = await resolveAuthorizedTask(kaneoClient, scope, params.issue_id);
          if (!taskCheck.ok) return taskCheck.error;

          const current = taskCheck.task;
          const updated = await kaneoClient.updateTask(params.issue_id, {
            title: params.patch.title ?? current.title,
            ...(params.patch.description !== undefined ? { description: params.patch.description } : {}),
            priority: params.patch.priority ?? current.priority ?? "no-priority",
            status: params.patch.status ?? current.status,
            projectId: current.projectId,
            position: current.position ?? 0,
            ...(params.patch.startDate !== undefined
              ? { startDate: params.patch.startDate }
              : current.startDate
                ? { startDate: current.startDate }
                : {}),
            ...(params.patch.dueDate !== undefined
              ? { dueDate: params.patch.dueDate }
              : current.dueDate
                ? { dueDate: current.dueDate }
                : {}),
            ...(current.userId ? { userId: current.userId } : {}),
          });

          return toolOk({
            ok: true,
            action,
            applied_by_profile: scope.profile,
            issue: updated,
          });
        }

        if (action === "add_issue_tag") {
          const taskCheck = await resolveAuthorizedTask(kaneoClient, scope, params.issue_id);
          if (!taskCheck.ok) return taskCheck.error;

          const attached = await kaneoClient.attachLabelToTask(params.label_id, params.issue_id);
          return toolOk({
            ok: true,
            action,
            applied_by_profile: scope.profile,
            issue_id: params.issue_id,
            label_id: params.label_id,
            result: attached,
          });
        }

        if (action === "link_issue_relationship") {
          const sourceCheck = await resolveAuthorizedTask(kaneoClient, scope, params.source_task_id);
          if (!sourceCheck.ok) return sourceCheck.error;
          const targetCheck = await resolveAuthorizedTask(kaneoClient, scope, params.target_task_id);
          if (!targetCheck.ok) return targetCheck.error;

          const relation = await kaneoClient.createTaskRelation({
            sourceTaskId: params.source_task_id,
            targetTaskId: params.target_task_id,
            relationType: params.relation_type,
          });
          return toolOk({
            ok: true,
            action,
            applied_by_profile: scope.profile,
            relationship: relation,
          });
        }

        return toolError("UNSUPPORTED_ACTION", { action });
      } catch (error) {
        return normalizeUpstreamError(error, { action }).error;
      }
    },
  );

  return server;
}

/**
 * Builds the Fastify HTTP server hosting /healthz, /readyz, and stateless POST /mcp.
 */
export async function buildKanbanMcpServer({
  kaneoClient,
  tokens = parseMcpTokens(),
  confirmTtlMs = 5 * 60 * 1000,
  now = () => Date.now(),
  logger = false,
} = {}) {
  const app = Fastify({
    logger: logger
      ? {
          redact: ["req.headers.authorization"],
        }
      : false,
  });

  const confirmStore = createConfirmStore({ ttlMs: confirmTtlMs, now });

  function authenticate(request) {
    const auth = request.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7).trim();
    for (const entry of tokens) {
      if (constantTimeEquals(token, entry.token)) return entry;
    }
    return null;
  }

  app.get("/healthz", async () => ({
    status: "ok",
    service: "kanban-mcp",
    scopesCount: tokens.length,
  }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const upstream = await kaneoClient.health();
      return {
        status: "ready",
        service: "kanban-mcp",
        upstream,
      };
    } catch (error) {
      return reply.code(503).send({
        status: "not_ready",
        service: "kanban-mcp",
        error: error?.message || "kaneo unreachable",
      });
    }
  });

  app.all("/mcp", async (request, reply) => {
    const scope = authenticate(request);
    if (!scope) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (request.method !== "POST") {
      return reply.code(405).header("Allow", "POST").send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Stateless Streamable HTTP accepts POST /mcp only" },
        id: null,
      });
    }

    const server = createScopedMcpServer({ kaneoClient, scope, confirmStore });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  return {
    app,
    confirmStore,
    listSanitizedScopes: () =>
      tokens.map((entry) => ({
        profile: entry.profile,
        domainId: entry.domainId,
        allowedWorkspaceId: entry.allowedWorkspaceId,
        allowedProjectsCount: entry.allowedProjects.length,
      })),
  };
}
