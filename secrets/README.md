# Credenciais do `spoke-kanban` (Kaneo)

Cifre cada Kubernetes Secret em `secrets/*.sops.yaml` usando `sops` com a chave Age do HomeServer (`.sops.yaml`).

## Secret principal (`kanban-secrets.sops.yaml`)

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`: credenciais do PostgreSQL 16.
- `DATABASE_URL`: DSN completo usado pelo `kanban-kaneo` (`postgresql://kaneo:<SENHA>@kanban-postgres:5432/kaneo`).
- `AUTH_SECRET`: segredo de sessão do Kaneo (32 bytes em hex). Gere com:
  ```powershell
  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
  ```
- `KANEO_API_KEY`: API Key criada na interface do Kaneo (`Settings → Account → Developer / API Keys`), usada pelo `kanban-mcp` para autenticar contra `http://kanban-kaneo:5173/api`.
- `KANBAN_MCP_TOKENS_JSON`: mapa JSON de `token -> { profile, domainId, allowedWorkspaceId, allowedProjects }` usado pelo `kanban-mcp` (`:6062/mcp`) para isolar estritamente workspaces/projetos pessoais vs. clientes (`work-*`).

## Fluxo para cifrar e validar

1. Copie `secrets/kanban-secrets.example.yaml` para `secrets/kanban-secrets.sops.yaml` e preencha os valores reais.
2. Cifre com SOPS:
   ```powershell
   sops --encrypt --in-place secrets/kanban-secrets.sops.yaml
   ```
3. Crie `secrets/kustomization.yaml` listando `kanban-secrets.sops.yaml`.
4. Valide com `node scripts/validate.mjs`.
