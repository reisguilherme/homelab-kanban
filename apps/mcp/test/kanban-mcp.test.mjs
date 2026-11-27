import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createKaneoClient } from "../src/kaneo-client.mjs";
import { buildKanbanMcpServer } from "../src/mcp.mjs";

const WS_PERSONAL = "ws_personal_01";
const WS_ACME = "ws_acme_02";

const PROJ_PERSONAL_HS = "proj_hs_01";
const PROJ_PERSONAL_OTHER = "proj_other_02";
const PROJ_ACME_API = "proj_acme_03";

const LBL_PERS_SDD = "lbl_sdd_01";
const LBL_PERS_BACKEND = "lbl_backend_02";
const LBL_ACME_CONF = "lbl_acme_03";

const TASK_PERS_EPIC = "task_hs_01";
const TASK_PERS_OTHER = "task_other_02";
const TASK_ACME_SECRET = "task_acme_03";

async function startMockKaneoApi() {
  const app = Fastify({ logger: false });
  const apiKey = "kaneo_live_secret_key";
  let taskSeq = 10;

  const projects = [
    { id: PROJ_PERSONAL_HS, name: "HomeServer", slug: "HS", workspaceId: WS_PERSONAL, icon: "server", description: null, isPublic: false },
    { id: PROJ_PERSONAL_OTHER, name: "Personal Excluded", slug: "OTH", workspaceId: WS_PERSONAL, icon: "lock", description: null, isPublic: false },
    { id: PROJ_ACME_API, name: "ACME Secret API", slug: "ACME", workspaceId: WS_ACME, icon: "shield", description: null, isPublic: false },
  ];

  const columnsByProject = {
    [PROJ_PERSONAL_HS]: [
      { id: "col_1", projectId: PROJ_PERSONAL_HS, name: "To Do", slug: "to-do", position: 0, isFinal: false },
      { id: "col_2", projectId: PROJ_PERSONAL_HS, name: "In Review", slug: "in-review", position: 1, isFinal: false },
      { id: "col_3", projectId: PROJ_PERSONAL_HS, name: "Done", slug: "done", position: 2, isFinal: true },
    ],
    [PROJ_PERSONAL_OTHER]: [
      { id: "col_4", projectId: PROJ_PERSONAL_OTHER, name: "To Do", slug: "to-do", position: 0, isFinal: false },
    ],
    [PROJ_ACME_API]: [
      { id: "col_5", projectId: PROJ_ACME_API, name: "To Do", slug: "to-do", position: 0, isFinal: false },
    ],
  };

  const labels = [
    { id: LBL_PERS_SDD, name: "sdd", color: "#3b82f6", workspaceId: WS_PERSONAL },
    { id: LBL_PERS_BACKEND, name: "backend", color: "#10b981", workspaceId: WS_PERSONAL },
    { id: LBL_ACME_CONF, name: "confidential", color: "#ef4444", workspaceId: WS_ACME },
  ];

  const tasks = [
    {
      id: TASK_PERS_EPIC,
      projectId: PROJ_PERSONAL_HS,
      workspaceId: WS_PERSONAL,
      number: 1,
      title: "Setup spoke-kanban",
      description: "Implement Kaneo + kanban-mcp",
      status: "to-do",
      priority: "high",
      position: 0,
      userId: null,
      startDate: null,
      dueDate: null,
    },
    {
      id: TASK_PERS_OTHER,
      projectId: PROJ_PERSONAL_OTHER,
      workspaceId: WS_PERSONAL,
      number: 1,
      title: "Excluded personal project task",
      description: null,
      status: "to-do",
      priority: "low",
      position: 0,
      userId: null,
      startDate: null,
      dueDate: null,
    },
    {
      id: TASK_ACME_SECRET,
      projectId: PROJ_ACME_API,
      workspaceId: WS_ACME,
      number: 1,
      title: "ACME confidential contract task",
      description: "Must never leak to personal profile",
      status: "to-do",
      priority: "urgent",
      position: 0,
      userId: null,
      startDate: null,
      dueDate: null,
    },
  ];

  const taskLabels = new Map([[TASK_PERS_EPIC, [LBL_PERS_SDD]]]);
  const relations = [];

  function requireApiKey(request, reply) {
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      reply.code(401).send({ message: "Unauthorized" });
      return false;
    }
    return true;
  }

  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/project", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    return projects.filter((p) => p.workspaceId === request.query.workspaceId);
  });

  app.get("/api/project/:id", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const project = projects.find((p) => p.id === request.params.id);
    if (!project) return reply.code(404).send({ message: "Project not found" });
    return project;
  });

  app.get("/api/column/:projectId", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    return columnsByProject[request.params.projectId] ?? [];
  });

  app.get("/api/task/tasks/:projectId", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const project = projects.find((p) => p.id === request.params.projectId);
    if (!project) return reply.code(404).send({ message: "Project not found" });
    const cols = columnsByProject[project.id] ?? [];
    let filtered = tasks.filter((t) => t.projectId === project.id);
    if (request.query.status) filtered = filtered.filter((t) => t.status === request.query.status);
    if (request.query.priority) filtered = filtered.filter((t) => t.priority === request.query.priority);

    return {
      data: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        workspaceId: project.workspaceId,
        columns: cols.map((col) => ({
          ...col,
          tasks: filtered.filter((t) => t.status === col.slug),
        })),
        plannedTasks: [],
        archivedTasks: [],
      },
      pagination: { total: filtered.length, page: 1, pageSize: 50, totalPages: 1 },
    };
  });

  app.get("/api/task/:id", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const task = tasks.find((t) => t.id === request.params.id);
    if (!task) return reply.code(404).send({ message: "Task not found" });
    return task;
  });

  app.post("/api/task/:projectId", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const project = projects.find((p) => p.id === request.params.projectId);
    if (!project) return reply.code(404).send({ message: "Project not found" });
    const b = request.body;
    taskSeq += 1;
    const created = {
      id: `task_${crypto.randomUUID().slice(0, 8)}`,
      projectId: project.id,
      workspaceId: project.workspaceId,
      number: taskSeq,
      title: b.title,
      description: b.description ?? "",
      status: b.status,
      priority: b.priority ?? "no-priority",
      position: tasks.filter((t) => t.projectId === project.id && t.status === b.status).length,
      userId: b.userId ?? null,
      startDate: b.startDate ?? null,
      dueDate: b.dueDate ?? null,
    };
    tasks.push(created);
    return created;
  });

  app.put("/api/task/:id", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const task = tasks.find((t) => t.id === request.params.id);
    if (!task) return reply.code(404).send({ message: "Task not found" });
    Object.assign(task, request.body);
    return task;
  });

  app.get("/api/label/workspace/:workspaceId", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    return labels.filter((l) => l.workspaceId === request.params.workspaceId);
  });

  app.get("/api/label/task/:taskId", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const attachedIds = taskLabels.get(request.params.taskId) ?? [];
    return labels.filter((l) => attachedIds.includes(l.id));
  });

  app.put("/api/label/:id/task", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const { taskId } = request.body;
    const list = taskLabels.get(taskId) ?? [];
    if (!list.includes(request.params.id)) list.push(request.params.id);
    taskLabels.set(taskId, list);
    return { ok: true };
  });

  app.get("/api/task-relation/:taskId", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    return relations.filter(
      (r) => r.sourceTaskId === request.params.taskId || r.targetTaskId === request.params.taskId,
    );
  });

  app.post("/api/task-relation", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const rel = {
      id: `rel_${crypto.randomUUID().slice(0, 8)}`,
      sourceTaskId: request.body.sourceTaskId,
      targetTaskId: request.body.targetTaskId,
      relationType: request.body.relationType,
    };
    relations.push(rel);
    return rel;
  });

  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, url, apiKey };
}

async function connectMcp(baseUrl, token) {
  const client = new Client({ name: "hermes-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

test("kanban-mcp enforces Zero-Trust Kaneo workspace/project isolation and 2-step confirm_token mutations", async () => {
  const mockKaneo = await startMockKaneoApi();
  let clockMs = 1_700_000_000_000;

  const kaneoClient = createKaneoClient({
    baseUrl: `${mockKaneo.url}/api`,
    apiKey: mockKaneo.apiKey,
  });

  const tokens = [
    {
      token: "tok-personal",
      profile: "sdd-personal",
      domainId: "personal",
      allowedWorkspaceId: WS_PERSONAL,
      allowedProjects: [PROJ_PERSONAL_HS],
    },
    {
      token: "tok-acme",
      profile: "sdd-work-acme",
      domainId: "work-acme",
      allowedWorkspaceId: WS_ACME,
      allowedProjects: ["*"],
    },
  ];

  const { app } = await buildKanbanMcpServer({
    kaneoClient,
    tokens,
    confirmTtlMs: 300_000,
    now: () => clockMs,
    logger: false,
  });

  const mcpUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    // 1. Health, readiness, and HTTP auth guards
    const healthRes = await fetch(`${mcpUrl}/healthz`);
    assert.equal(healthRes.status, 200);
    const readyRes = await fetch(`${mcpUrl}/readyz`);
    assert.equal(readyRes.status, 200);

    const unauthRes = await fetch(`${mcpUrl}/mcp`, { method: "POST", body: "{}" });
    assert.equal(unauthRes.status, 401);

    const getMcpRes = await fetch(`${mcpUrl}/mcp`, {
      method: "GET",
      headers: { Authorization: "Bearer tok-personal" },
    });
    assert.equal(getMcpRes.status, 405);

    // 2. Scoped reads & cross-domain denial
    const personal = await connectMcp(mcpUrl, "tok-personal");
    const projectsRes = await personal.client.callTool({ name: "list_projects", arguments: { include_labels: true } });
    const projectsData = JSON.parse(projectsRes.content[0].text);
    assert.equal(projectsData.projects.length, 1);
    assert.equal(projectsData.projects[0].id, PROJ_PERSONAL_HS);
    assert.equal(projectsData.labels.length, 2);

    const forbiddenCrossWsList = await personal.client.callTool({
      name: "list_issues",
      arguments: { project_id: PROJ_ACME_API },
    });
    assert.equal(forbiddenCrossWsList.isError, true);
    assert.match(forbiddenCrossWsList.content[0].text, /FORBIDDEN_DOMAIN/);

    const forbiddenSameWsExcludedProject = await personal.client.callTool({
      name: "get_issue_details",
      arguments: { issue_id: TASK_PERS_OTHER },
    });
    assert.equal(forbiddenSameWsExcludedProject.isError, true);
    assert.match(forbiddenSameWsExcludedProject.content[0].text, /FORBIDDEN_DOMAIN/);

    const forbiddenCrossWsDetails = await personal.client.callTool({
      name: "get_issue_details",
      arguments: { issue_id: TASK_ACME_SECRET },
    });
    assert.equal(forbiddenCrossWsDetails.isError, true);
    assert.match(forbiddenCrossWsDetails.content[0].text, /FORBIDDEN_DOMAIN/);

    // Cross-domain relationship proposal must be rejected
    const forbiddenProposeRel = await personal.client.callTool({
      name: "propose_link_issue_relationship",
      arguments: {
        issue_id: TASK_PERS_EPIC,
        related_issue_id: TASK_ACME_SECRET,
        relationship_type: "blocking",
      },
    });
    assert.equal(forbiddenProposeRel.isError, true);
    assert.match(forbiddenProposeRel.content[0].text, /FORBIDDEN_DOMAIN/);

    // 3. Apply without valid confirm_token fails
    const invalidApply = await personal.client.callTool({
      name: "apply_kanban_mutation",
      arguments: { confirm_token: "confirm_nonexistent" },
    });
    assert.equal(invalidApply.isError, true);
    assert.match(invalidApply.content[0].text, /CONFIRM_TOKEN_INVALID/);

    // 4. Full 2-step create_issue with priority, labels, and parent_issue_id (subtask relation)
    const proposeCreate = await personal.client.callTool({
      name: "propose_create_issue",
      arguments: {
        project_id: PROJ_PERSONAL_HS,
        title: "Implement kanban-mcp healthchecks",
        description: "Derived from ADR-0004",
        priority: "high",
        tags: ["sdd", "backend"],
        parent_issue_id: TASK_PERS_EPIC,
      },
    });
    assert.equal(Boolean(proposeCreate.isError), false);
    const createProposal = JSON.parse(proposeCreate.content[0].text);
    assert.ok(createProposal.confirm_token.startsWith("confirm_"));
    assert.equal(createProposal.preview.column.slug, "to-do");

    // Hash mismatch must fail without consuming token
    const badHashApply = await personal.client.callTool({
      name: "apply_kanban_mutation",
      arguments: { confirm_token: createProposal.confirm_token, params_hash: "0000" },
    });
    assert.equal(badHashApply.isError, true);
    assert.match(badHashApply.content[0].text, /CONFIRM_TOKEN_HASH_MISMATCH/);

    // Cross-profile token replay must fail
    const acme = await connectMcp(mcpUrl, "tok-acme");
    const crossProfileReplay = await acme.client.callTool({
      name: "apply_kanban_mutation",
      arguments: { confirm_token: createProposal.confirm_token },
    });
    assert.equal(crossProfileReplay.isError, true);
    assert.match(crossProfileReplay.content[0].text, /CONFIRM_TOKEN_SCOPE_MISMATCH/);

    // Valid apply succeeds
    const appliedCreate = await personal.client.callTool({
      name: "apply_kanban_mutation",
      arguments: {
        confirm_token: createProposal.confirm_token,
        params_hash: createProposal.params_hash,
      },
    });
    assert.equal(Boolean(appliedCreate.isError), false);
    const createdData = JSON.parse(appliedCreate.content[0].text);
    assert.equal(createdData.ok, true);
    assert.equal(createdData.issue.priority, "high");
    assert.equal(createdData.attached_label_ids.length, 2);
    assert.equal(createdData.parent_relation.relationType, "subtask");
    assert.equal(createdData.parent_relation.sourceTaskId, TASK_PERS_EPIC);

    // Single-use token replay must fail
    const replayCreate = await personal.client.callTool({
      name: "apply_kanban_mutation",
      arguments: { confirm_token: createProposal.confirm_token },
    });
    assert.equal(replayCreate.isError, true);
    assert.match(replayCreate.content[0].text, /CONFIRM_TOKEN_INVALID/);

    // 5. Token TTL expiration (5 min)
    const proposeExpire = await personal.client.callTool({
      name: "propose_update_issue",
      arguments: {
        issue_id: createdData.issue.id,
        status: "In Review",
      },
    });
    const expireProposal = JSON.parse(proposeExpire.content[0].text);
    clockMs += 301_000;
    const expiredApply = await personal.client.callTool({
      name: "apply_kanban_mutation",
      arguments: { confirm_token: expireProposal.confirm_token },
    });
    assert.equal(expiredApply.isError, true);
    assert.match(expiredApply.content[0].text, /CONFIRM_TOKEN_EXPIRED/);

    // 6. update_issue, add_issue_tag, and link_issue_relationship ("blocking" -> "blocks")
    const proposeUpdate = await personal.client.callTool({
      name: "propose_update_issue",
      arguments: {
        issue_id: createdData.issue.id,
        status: "In Review",
        priority: "urgent",
      },
    });
    const updateProposal = JSON.parse(proposeUpdate.content[0].text);
    const appliedUpdate = await personal.client.callTool({
      name: "apply_kanban_mutation",
      arguments: { confirm_token: updateProposal.confirm_token },
    });
    const updatedData = JSON.parse(appliedUpdate.content[0].text);
    assert.equal(updatedData.issue.status, "in-review");
    assert.equal(updatedData.issue.priority, "urgent");

    const proposeTag = await personal.client.callTool({
      name: "propose_add_issue_tag",
      arguments: { issue_id: TASK_PERS_EPIC, tag_name: "backend" },
    });
    const tagProposal = JSON.parse(proposeTag.content[0].text);
    const appliedTag = await personal.client.callTool({
      name: "apply_kanban_mutation",
      arguments: { confirm_token: tagProposal.confirm_token },
    });
    assert.equal(JSON.parse(appliedTag.content[0].text).label_id, LBL_PERS_BACKEND);

    const proposeRel = await personal.client.callTool({
      name: "propose_link_issue_relationship",
      arguments: {
        issue_id: createdData.issue.id,
        related_issue_id: TASK_PERS_EPIC,
        relationship_type: "blocking",
      },
    });
    const relProposal = JSON.parse(proposeRel.content[0].text);
    const appliedRel = await personal.client.callTool({
      name: "apply_kanban_mutation",
      arguments: { confirm_token: relProposal.confirm_token },
    });
    assert.equal(JSON.parse(appliedRel.content[0].text).relationship.relationType, "blocks");

    // Verify details reflect labels + relationships
    const detailsRes = await personal.client.callTool({
      name: "get_issue_details",
      arguments: { issue_id: createdData.issue.id },
    });
    const details = JSON.parse(detailsRes.content[0].text);
    assert.equal(details.labels.length, 2);
    assert.equal(details.relationships.length, 2);

    // ACME profile sees only ACME project
    const acmeProjects = await acme.client.callTool({ name: "list_projects", arguments: {} });
    const acmeData = JSON.parse(acmeProjects.content[0].text);
    assert.equal(acmeData.projects.length, 1);
    assert.equal(acmeData.projects[0].id, PROJ_ACME_API);

    await personal.transport.close();
    await acme.transport.close();
  } finally {
    await app.close();
    await mockKaneo.app.close();
  }
});
