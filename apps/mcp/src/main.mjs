import { loadConfig } from "./config.mjs";
import { createKaneoClient } from "./kaneo-client.mjs";
import { buildKanbanMcpServer } from "./mcp.mjs";

const config = loadConfig();
const kaneoClient = createKaneoClient({
  baseUrl: config.kaneoApiUrl,
  apiKey: config.kaneoApiKey,
});

const { app, listSanitizedScopes } = await buildKanbanMcpServer({
  kaneoClient,
  tokens: config.tokens,
  confirmTtlMs: config.confirmTtlMs,
  logger: true,
});

app.log.info(
  {
    host: config.host,
    port: config.port,
    kaneoApiUrl: config.kaneoApiUrl,
    scopes: listSanitizedScopes(),
  },
  "Starting kanban-mcp server",
);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down kanban-mcp server");
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
