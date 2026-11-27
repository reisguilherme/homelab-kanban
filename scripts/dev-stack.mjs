#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const COMPOSE_FILE = path.join(root, "docker-compose.dev.yml");

function run(command, args, { env = process.env, cwd = root, allowFailure = false, shell = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.status ?? 0;
}

function getOrCreateDevAuthSecret() {
  if (process.env.AUTH_SECRET) {
    return process.env.AUTH_SECRET;
  }
  const cacheFile = path.join(os.tmpdir(), "homelab-kanban-kaneo-auth-secret.txt");
  if (fs.existsSync(cacheFile)) {
    const existing = fs.readFileSync(cacheFile, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(cacheFile, `${generated}\n`, "utf8");
  return generated;
}

function buildDevEnv() {
  const defaultTokens = JSON.stringify({
    "dev-personal-token": {
      profile: "sdd-personal",
      domainId: "personal",
      allowedWorkspaceId: process.env.DEV_ALLOWED_WORKSPACE_ID || "dev-workspace",
      allowedProjects: ["*"],
    },
  });

  return {
    ...process.env,
    POSTGRES_DB: process.env.POSTGRES_DB || "kaneo",
    POSTGRES_USER: process.env.POSTGRES_USER || "kaneo",
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || "kaneo-dev-pass",
    KANEO_CLIENT_URL: process.env.KANEO_CLIENT_URL || "http://127.0.0.1:5173",
    AUTH_SECRET: getOrCreateDevAuthSecret(),
    KANEO_API_KEY: process.env.KANEO_API_KEY || "",
    KANBAN_MCP_TOKENS_JSON: process.env.KANBAN_MCP_TOKENS_JSON || defaultTokens,
  };
}

async function waitForHealth(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`${label} ready (${url})`);
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

const [command = "help", ...args] = process.argv.slice(2);
const env = buildDevEnv();

if (command === "up") {
  run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--build", ...args], { env });
  await waitForHealth("http://127.0.0.1:5173/api/health", "Kaneo");
  await waitForHealth("http://127.0.0.1:6062/healthz", "kanban-mcp");
  console.log("");
  console.log("Local spoke-kanban (Kaneo) stack is ready:");
  console.log("  Web UI          : http://127.0.0.1:5173");
  console.log("  Kaneo Native MCP: http://127.0.0.1:5173/api/mcp");
  console.log("  Zero-Trust MCP  : http://127.0.0.1:6062/mcp (Bearer token from KANBAN_MCP_TOKENS_JSON)");
  console.log("  Setup @kaneo/mcp: npm run dev:mcp");
} else if (command === "down") {
  run("docker", ["compose", "-f", COMPOSE_FILE, "down", ...args], { env });
} else if (command === "logs") {
  run("docker", ["compose", "-f", COMPOSE_FILE, "logs", "-f", ...args], { env });
} else if (command === "status") {
  run("docker", ["compose", "-f", COMPOSE_FILE, "ps", ...args], { env });
} else if (command === "mcp") {
  const mcpEnv = {
    ...process.env,
    KANEO_API_URL: process.env.KANEO_API_URL || "http://127.0.0.1:5173/api",
  };
  console.log(`Launching @kaneo/mcp pointing to ${mcpEnv.KANEO_API_URL}...`);
  run("npx", ["-y", "@kaneo/mcp", ...args], {
    env: mcpEnv,
    shell: process.platform === "win32",
  });
} else {
  console.log("Usage: node scripts/dev-stack.mjs <up|down|logs|status|mcp>");
  process.exit(command === "help" ? 0 : 1);
}
