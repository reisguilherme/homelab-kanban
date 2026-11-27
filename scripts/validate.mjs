#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const forbidden = new Set([".artifacts", ".runtime", ".worktrees", ".private-vault", "backup", "graphify-out"]);
const keyMaterial = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|AGE-SECRET-KEY-1[0-9A-Z]+/;
const ciphertext = /^ENC\[AES256_GCM,data:[\w+/=]+,iv:[\w+/=]+,tag:[\w+/=]+,type:str\]$/;
const digestPattern = /@sha256:[0-9a-f]{64}$/;
const secretFiles = [];
const errors = [];

function run(command, args, source, input) {
  const result = spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024 });
  if (result.status === 0) return result.stdout;
  const cause = result.error?.code ?? `exit ${result.status}`;
  throw new Error(`${source}: ${command} ${args[0]} failed (${cause})`);
}

function resources(yaml, source) {
  if (!yaml.trim()) return [];
  const output = run(
    "kubectl",
    ["patch", "--local", "--type=merge", "-p", "{}", "-f", "-", "-o", 'jsonpath={@}{"\\n"}'],
    source,
    yaml,
  );
  return output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function checkSecret(resource, source) {
  if (resource.kind !== "Secret") return;
  const fields = [resource.data, resource.stringData].filter((field) => field !== undefined);
  if (!resource.sops?.age?.length || !ciphertext.test(resource.sops.mac)) {
    errors.push(`${source}: Secret requires SOPS/Age metadata`);
  }
  for (const field of fields) {
    if (
      !field ||
      typeof field !== "object" ||
      Array.isArray(field) ||
      !Object.values(field).every((value) => typeof value === "string" && ciphertext.test(value))
    ) {
      errors.push(`${source}: every value in Secret data and stringData must be encrypted`);
    }
  }
}

function inspectFile(file, source) {
  const name = path.basename(file);
  if (/^\.env(?:\.|$)/i.test(name) && name !== ".env.example") {
    errors.push(`${source}: plaintext environment files are prohibited`);
    return;
  }
  if (/\.(?:woff2?|png|jpe?g|webp|ico|gif|avif|db|sqlite)$/i.test(name)) return;
  const content = fs.readFileSync(file, "utf8");
  if (keyMaterial.test(content)) errors.push(`${source}: private key material detected`);
  if (name === ".sops.yaml" || !/\.(?:ya?ml|json)$/i.test(name)) return;
  const encrypted = /\.sops\.ya?ml$/i.test(name);
  if (name.endsWith(".example.yaml")) return;
  if (!encrypted && !/["']?apiVersion["']?\s*:/.test(content)) return;
  const secretFile = source.startsWith("secrets/") && name.endsWith(".sops.yaml");
  for (const resource of resources(content, source)) {
    if (resource.kind === "Secret" && !secretFile) {
      errors.push(`${source}: Kubernetes Secrets belong in secrets/ with a *.sops.yaml suffix`);
    }
    if (secretFile) secretFiles.push({ source, mac: resource.sops?.mac });
    checkSecret(resource, source);
  }
  if (encrypted && !JSON.parse(run("sops", ["filestatus", file], source)).encrypted) {
    errors.push(`${source}: SOPS reports the file is unencrypted`);
  }
}

const skipDirs = new Set([".git", "node_modules", ".venv", "__pycache__"]);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const source = path.relative(root, file).split(path.sep).join("/");
    if (forbidden.has(entry.name)) errors.push(`${source}: prohibited workspace directory`);
    else if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) {
      try {
        inspectFile(file, source);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
}

walk(root);

try {
  const upstream = JSON.parse(fs.readFileSync(path.join(root, "upstream", "kaneo.json"), "utf8"));
  if (!upstream.repository || !upstream.ref) {
    errors.push("upstream/kaneo.json: repository and ref are required");
  }
  for (const key of ["kaneoImage", "postgresImage"]) {
    if (!digestPattern.test(String(upstream[key] ?? ""))) {
      errors.push(`upstream/kaneo.json: ${key} must be pinned with @sha256`);
    }
  }
} catch (error) {
  errors.push(`upstream/kaneo.json: ${error.message}`);
}

function checkPodScheduling(podSpec, label, dir) {
  if (podSpec?.nodeSelector?.["homelab.greis.dev.br/tier"] !== "auxiliary") {
    errors.push(`${dir}: ${label} requires nodeSelector homelab.greis.dev.br/tier=auxiliary`);
  }
  const hasToleration = (podSpec?.tolerations ?? []).some(
    (tol) =>
      tol.key === "homelab.greis.dev.br/tier" &&
      tol.operator === "Equal" &&
      tol.value === "auxiliary" &&
      tol.effect === "NoSchedule",
  );
  if (!hasToleration) {
    errors.push(`${dir}: ${label} requires NoSchedule toleration for homelab.greis.dev.br/tier=auxiliary`);
  }
  for (const container of [...(podSpec?.initContainers ?? []), ...(podSpec?.containers ?? [])]) {
    if (!digestPattern.test(container.image)) {
      errors.push(`${dir}: ${label}/${container.name} requires an @sha256 image digest`);
    }
  }
}

for (const dir of ["kubernetes", "secrets"]) {
  const folder = path.join(root, dir);
  if (dir === "secrets" && !fs.existsSync(path.join(folder, "kustomization.yaml"))) {
    if (secretFiles.length) errors.push("secrets/kustomization.yaml is required for encrypted files");
    continue;
  }
  try {
    const built = resources(run("kubectl", ["kustomize", folder], dir), dir);
    if (dir === "kubernetes" && !built.length) errors.push("kubernetes: empty render");
    for (const resource of built) {
      checkSecret(resource, dir);
      if (resource.kind === "Deployment" || resource.kind === "StatefulSet") {
        checkPodScheduling(
          resource.spec.template.spec,
          `${resource.kind} ${resource.metadata.name}`,
          dir,
        );
      } else if (resource.kind === "CronJob") {
        checkPodScheduling(
          resource.spec.jobTemplate.spec.template.spec,
          `CronJob ${resource.metadata.name}`,
          dir,
        );
      }
    }
    if (dir === "secrets") {
      const rendered = new Set(built.map((resource) => resource.sops?.mac));
      for (const { source, mac } of secretFiles) {
        if (!mac || !rendered.delete(mac)) errors.push(`${source}: missing from secrets/kustomization.yaml render`);
      }
    }
    console.log(`${dir}: ${built.length} rendered resources`);
  } catch (error) {
    errors.push(error.message);
  }
}

for (const error of errors) console.error(error);
if (errors.length) process.exitCode = 1;
else console.log("Kanban validation passed.");
