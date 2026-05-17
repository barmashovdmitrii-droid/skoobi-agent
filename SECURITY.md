# Security Policy

Skoobi Agent is a Telegram-first assistant runtime. Security issues should be reported privately to the repository owner/maintainer, not through public issues.

## Secrets

Never commit:

- `.env` or `.env.*`
- Telegram bot tokens
- OpenAI, Anthropic, GitHub, Slack, or other API keys
- Codex or Claude auth/session files
- browser cookies or localStorage/sessionStorage
- SSH private keys
- `groups/`, `store/`, `logs/`, `dashboard/`, or runtime databases

`.env.example` must contain placeholders or safe defaults only.

## Auth Boundaries

Skoobi must not scrape, copy, or print:

- `~/.codex/auth.json`
- `~/.claude` auth/session files
- browser cookies
- OAuth access/refresh tokens
- SSH private keys

Codex subscription runtime may use the official local `codex` CLI, but must not inspect or export its credentials.

## Tenant Isolation

Guest tenants must not access:

- owner/main tenant memory
- another tenant's memory
- `.env`
- `message database`
- `~/.ssh`
- `~/.codex`
- `~/.claude`
- raw runtime folders outside their allowed scope

Telegram identity is based on Telegram IDs, not display name or username.

## Tool Policy

The model is not a trusted security boundary. Tool availability and execution must be decided by Skoobi through registry/policy/audit controls. Guest tenants must not see or call owner tools.

## Rollback

Claude SDK fallback and rollback scripts are part of the safety boundary. Do not remove them without a separate reviewed migration.
