const DEFAULT_CONFIRM_TTL_MS = 5 * 60 * 1000;

/**
 * Parses KANBAN_MCP_TOKENS_JSON into validated per-profile authorization scopes.
 * Entries missing a token or allowedWorkspaceId are ignored (fail-closed).
 */
export function parseMcpTokens(rawJson = process.env.KANBAN_MCP_TOKENS_JSON || "{}") {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = {};
  }

  const entries = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return entries;
  }

  for (const [token, scope] of Object.entries(parsed)) {
    if (!token || !scope || typeof scope !== "object") continue;
    const allowedWorkspaceId = String(
      scope.allowedWorkspaceId ??
        scope.allowed_workspace_id ??
        scope.allowedOrgId ??
        scope.allowed_org_id ??
        "",
    ).trim();
    if (!allowedWorkspaceId) continue;

    const rawProjects = scope.allowedProjects ?? scope.allowed_projects;
    const allowedProjects = Array.isArray(rawProjects)
      ? rawProjects.map((value) => String(value).trim()).filter(Boolean)
      : [];

    entries.push({
      token,
      profile: String(scope.profile ?? "unknown"),
      domainId: String(scope.domainId ?? scope.domain_id ?? "personal"),
      allowedWorkspaceId,
      allowedProjects,
    });
  }

  return entries;
}

/**
 * Loads runtime configuration for the kanban-mcp HTTP server.
 */
export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.MCP_PORT ?? "6062", 10);
  const ttlRaw = Number.parseInt(env.CONFIRM_TOKEN_TTL_MS ?? String(DEFAULT_CONFIRM_TTL_MS), 10);

  return {
    host: env.MCP_HOST || "0.0.0.0",
    port: Number.isFinite(port) && port > 0 ? port : 6062,
    kaneoApiUrl: (env.KANEO_API_URL || env.KANBAN_REMOTE_URL || "http://127.0.0.1:5173/api").replace(/\/+$/, ""),
    kaneoApiKey: env.KANEO_API_KEY || "",
    confirmTtlMs: Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_CONFIRM_TTL_MS,
    tokens: parseMcpTokens(env.KANBAN_MCP_TOKENS_JSON || "{}"),
  };
}
