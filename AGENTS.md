# Manutenção do Spoke Kanban (`spoke-kanban`)

Este repositório é dono dos manifestos GitOps do **Kaneo** (`usekaneo/kaneo`, MIT, pinado em `upstream/kaneo.json`), da configuração de ambiente local Windows e do adaptador **`kanban-mcp`** (`:6062/mcp`) de `spoke-kanban`. O Hub fornece roteamento (`kanban.greis.dev.br` com `private-network-only` + `security-headers`, sem Authelia para preservar sessões/API Keys e MCP nativo `/api/mcp`) e observabilidade compartilhados.

- **Sem UI própria:** utilize sempre a Web UI, o backend e o MCP nativo (`/api/mcp` + `@kaneo/mcp`) oficiais do `usekaneo/kaneo` pinados em `upstream/kaneo.json`.
- **Adaptador `kanban-mcp` (`apps/mcp`, `:6062/mcp`):** serviço fino Streamable-HTTP para o `spoke-hermes` conectado à API `/api/*` do Kaneo (`:5173`). Cada Bearer Token de profile Hermes carrega `allowedWorkspaceId` e `allowedProjects` aplicados no servidor (`FORBIDDEN_DOMAIN` em qualquer tentativa cross-domain).
- **Mutações protegidas:** toda escrita via `kanban-mcp` (`create_issue`, `update_issue`, `add_issue_tag`, `link_issue_relationship`) exige fluxo em 2 etapas (`propose_*` → `apply_kanban_mutation`) com `confirm_token` de uso único (TTL 5 min vinculado ao hash SHA-256 dos parâmetros).
- **Agendamento no Worker:** todos os workloads de `kubernetes/` devem conter `nodeSelector` e `toleration` para `homelab.greis.dev.br/tier=auxiliary` (`Lenovo M710q`) e imagens pinadas com `@sha256`.
- **Segredos e higiene:** cifre cada Secret em `secrets/*.sops.yaml` com Age (`.sops.yaml`). Nunca copie conteúdo de `.private-vault/`, nunca versione `.env` reais e nunca crie `.worktrees/`, `.artifacts/`, `.runtime/` ou `backup/`.
- **Validação:** rode `npm test` e `node scripts/validate.mjs` antes de abrir commit/PR. Produção acompanha commits revisados em `main` via FluxCD.
