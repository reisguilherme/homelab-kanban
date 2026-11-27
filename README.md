# Spoke Kanban (`homelab-kanban`)

Spoke GitOps do **Kaneo** (`usekaneo/kaneo`, MIT) e do adaptador interno **`kanban-mcp`** (`:6062/mcp`) para o pipeline SDD do HomeServer.

## Arquitetura

- **Board Central (`kanban-kaneo:5173` + `postgres:16-alpine`):** usa a imagem oficial pré-compilada de `usekaneo/kaneo` (pinada em [`upstream/kaneo.json`](upstream/kaneo.json)), com Workspaces isolados (`personal` vs. `work-*`), subtasks, dependências, prioridades, labels, integração nativa GitHub/GitLab/Gitea e endpoint MCP nativo (`/api/mcp` + `@kaneo/mcp`) para agentes locais no Desktop Windows.
- **Adaptador `kanban-mcp` (`apps/mcp/`, `:6062/mcp`):** servidor MCP Streamable-HTTP sem estado para o `spoke-hermes` com:
  - isolamento Zero-Trust por Bearer Token (`allowedWorkspaceId` + `allowedProjects`, retornando `FORBIDDEN_DOMAIN` em qualquer tentativa cross-domain);
  - escrita em 2 etapas com `confirm_token` de uso único (TTL 5 min vinculado ao hash SHA-256 dos parâmetros) via `propose_create_issue`, `propose_update_issue`, `propose_add_issue_tag`, `propose_link_issue_relationship` e `apply_kanban_mutation`.

---

## Teste Local no Desktop Windows (PowerShell)

Pré-requisitos: **Node.js >= 22** e **Docker Desktop** em execução.

1. **Instale dependências e valide o repositório:**
   ```powershell
   npm install
   npm test
   npm run validate
   ```

2. **Suba a stack local (`postgres` + `kaneo` + `kanban-mcp`):**
   ```powershell
   npm run dev:up
   ```
   *(Usa a imagem oficial `ghcr.io/usekaneo/kaneo:2.50.0` diretamente — sobe em segundos sem compilar nada.)*

3. **Acesse a Web UI local e crie sua conta/workspace:**
   - Abra `http://127.0.0.1:5173`
   - Crie sua conta local, um Workspace (ex.: `Personal`) e um projeto de teste.
   - Em **Settings → Account → Developer / API Keys**, gere uma API Key (`KANEO_API_KEY`) se quiser testar o `kanban-mcp` autenticado contra a API local.

4. **Conecte seus coding agents locais (Claude Code, Codex, Gemini CLI, Emdash):**
   - **Via MCP HTTP nativo do Kaneo:** aponte o cliente MCP para `http://127.0.0.1:5173/api/mcp` (OAuth/PKCE nativo no browser) ou use `npx -y @kaneo/mcp` (`npm run dev:mcp`) com `KANEO_API_URL=http://127.0.0.1:5173/api` e `KANEO_API_KEY=<sua-chave>`.
   - **Worktrees no Desktop Windows:** abra seu repositório no **Emdash** (`generalaction/emdash`) ou worktree local e instrua o agente a consultar/atualizar os cards no Kaneo via MCP.

5. **Valide o `kanban-mcp` (`:6062`):**
   ```powershell
   Invoke-RestMethod http://127.0.0.1:6062/readyz
   # Sem Bearer Token deve retornar 401:
   try { Invoke-WebRequest -Method POST http://127.0.0.1:6062/mcp -Body '{}' -ContentType 'application/json' } catch { $_.Exception.Response.StatusCode.value__ }
   ```
   - Para testar o `kanban-mcp` com sua API Key local e seu `workspaceId`:
     ```powershell
     $env:KANEO_API_KEY="<SUA_API_KEY>"
     $env:DEV_ALLOWED_WORKSPACE_ID="<SEU_WORKSPACE_ID>"
     npm run dev:up
     ```
   - Para encerrar a stack local:
     ```powershell
     npm run dev:down
     ```

---

## Checklist de Integração no Cluster (`homelab-platform` + `M710q`)

Quando for subir o Spoke no cluster K3s (`homelab-k3s-worker-01`, `tier=auxiliary`):

1. **Publicar imagem `kanban-mcp` no GHCR:** dê push deste repositório para `github.com/reisguilherme/homelab-kanban` (`main`). O workflow [`.github/workflows/kanban.yml`](.github/workflows/kanban.yml) fará o build do `kanban-mcp`, publicará no GHCR e pinará o digest `@sha256` em [`kubernetes/kanban-mcp.yaml`](kubernetes/kanban-mcp.yaml). A imagem do Kaneo já vem pinada por `@sha256` direto do `ghcr.io/usekaneo/kaneo` em [`kubernetes/kaneo.yaml`](kubernetes/kaneo.yaml).
2. **Criar segredos cifrados com SOPS/Age:** siga [`secrets/README.md`](secrets/README.md) para gerar `secrets/kanban-secrets.sops.yaml` e `secrets/kustomization.yaml`.
3. **Adicionar rota no Hub Traefik (`homelab-platform/infrastructure/hub/traefik/dynamic/routes-k3s.yml`):**
   Crie um roteador dedicado **sem `sso-auth`** (para preservar sessões/API Keys do Kaneo e o endpoint MCP `/api/mcp`):
   ```yaml
   kanban-remote:
     rule: "Host(`kanban.greis.dev.br`)"
     priority: 50
     entryPoints: ["websecure"]
     middlewares: ["private-network-only", "security-headers"]
     service: k3s-ingress
   ```
4. **Registrar o Spoke em `homelab-platform/kubernetes/spokes-registry/kanban.yaml`:**
   Cadastre `GitRepository` (`spoke-kanban`) e os dois `Kustomization`s (`spoke-kanban` em `./kubernetes` e `spoke-kanban-secrets` em `./secrets` com `decryption.provider: sops`), adicionando `- kanban.yaml` em `homelab-platform/kubernetes/spokes-registry/kustomization.yaml`.
5. **Liberar acesso no `spoke-hermes`:** configure o `hermes-agent` (`homelab-hermes`) para apontar os profiles `sdd-personal` / `sdd-work-<cliente>` para `http://kanban-mcp.spoke-kanban.svc.cluster.local:6062/mcp` com os respectivos Bearer Tokens.
