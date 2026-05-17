# Skoobi Agent

Skoobi Agent is a Telegram-first personal assistant runtime. This public edition is the open-source base for running a Skoobi instance with tenant isolation, quota accounting, memory provenance, Codex subscription primary runtime, and Claude SDK fallback.

## Runtime Shape

- Telegram is the primary channel.
- New installs keep guest live disabled by default: `SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED=false`.
- Owner/main tenants are excluded from guest live and should remain on the legacy Claude SDK path unless separately reviewed.
- Primary guest provider can be `codex_subscription_cli`.
- Fallback provider can be `claude_sdk`.
- Requested Codex model is `gpt-5.5`.
- Downgrade to `gpt-5.4` is disabled unless `SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE=true` is explicitly set.
- WhatsApp, MCP, and owner shell/write/restart tools are not part of the public guest runtime surface.

## Quick Install

Review `scripts/install.sh` before piping remote shell into `bash`.

Future public release command:

```bash
curl -fsSL https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/latest/download/install.sh | bash
```

or:

```bash
bash <(curl -fsSL https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/latest/download/install.sh)
```

The installer uses an app/instance layout:

```text
~/.skoobi/app/skoobi-agent/          # code
~/.skoobi/instances/default/         # .env, store, groups, logs, data
```

Set `--repo git@github.com:barmashovdmitrii-droid/skoobi-agent.git` when installing from a private fork or when using a custom repository location.

See [Install](docs/INSTALL.md) for macOS/Linux service management, update, and uninstall commands.

## Runtime Overview

```text
Telegram update
  -> tenant registry
  -> event store
  -> quota and safety pre-handlers
  -> runtime selection
  -> Skoobi live for guest tenants
       primary: codex_subscription_cli
       fallback: claude_sdk
  -> Telegram response
  -> usage ledger / model traces / audit events
```

The legacy Claude SDK runtime remains the rollback path. Skoobi live must never be treated as a replacement for audit, policy, tenant isolation, or rollback controls.

## Providers

### Codex Subscription CLI

The Codex provider is an experimental runtime adapter. It uses the locally installed `codex` CLI and the machine's existing `codex login` state. It does not read or copy `~/.codex/auth.json`, browser cookies, OAuth tokens, or session tokens.

Codex is run in an isolated scratch directory. The adapter does not give Codex access to `groups/`, `store/`, `.env`, `~/.ssh`, `~/.claude`, or `~/.codex`, and it does not pass Skoobi tools to Codex.

Recommended model settings:

```bash
SKOOBI_MODEL_GATEWAY_TYPE=codex_subscription_cli
SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true
SKOOBI_CODEX_MODEL=gpt-5.5
SKOOBI_CODEX_FALLBACK_MODEL=gpt-5.4
SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE=false
```

### Claude SDK Fallback

If Codex is unavailable, not logged in, timed out, rate-limited, returns no usable answer, or hits a model availability error, Skoobi can fall back to the Claude SDK runtime. The fallback must produce at most one user-visible Telegram answer and must not double-charge usage.

## Tenant Safety

Telegram identity is based on stable Telegram IDs:

- tenant identity: `tenant_id` plus channel/chat scope
- user identity for quota: `tenant_id + channel + Telegram from.id`

Display names and usernames are never identity. Owner/main tenants are excluded from guest live rollout and should stay on `claude_sdk` unless a separate owner-specific migration is designed and reviewed.

## Quota And Internal Credits

Skoobi uses internal credits rather than showing provider cost to users. Raw provider usage is kept for audit where available.

Key settings:

```bash
SKOOBI_GLOBAL_CREDIT_COEFFICIENT=100000
SKOOBI_DEFAULT_WEEKLY_LIMIT_CREDITS=700000
SKOOBI_CODEX_CREDITS_PER_REQUEST=1000
```

User-facing quota commands:

- `/limit`
- `/balance`
- natural-language requests such as `Покажи мой лимит`, `Сколько токенов осталось?`, `show my limit`

Quota status requests do not call the model and must not create `usage_ledger` charges.

## Memory And Privacy

Skoobi memory is tenant-scoped. Guest tenants must not receive owner/global memory or another tenant's memory.

New memory entries should include provenance metadata:

- `tenant_id`
- `sender_id` when Telegram sender is available
- `source_type`
- `message_id` or `event_id` when available
- `confidence`
- `created_at`

Legacy markdown memory without provenance is treated cautiously and should be labeled uncertain. Photo/video-derived facts default to low confidence unless confirmed by the user.

Memory deletion requires exact confirmation:

```text
ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ
```

Deletion/tombstone flow must only affect tenant/sender-scoped memory. It must not delete messages, events, model traces, usage ledger rows, or audit/accounting data.

## Repository Hygiene

Do not commit:

- `.env` or `.env.*`
- `groups/`
- `store/`
- `messages.db`
- `logs/`
- `dashboard/`
- `.codex/`
- `.claude/` auth/session data
- `.ssh/`

`groups/`, `store/`, runtime logs, and local auth/session files are instance state, not source code.

## Key Documentation

- [Install](docs/INSTALL.md)
- [Release](docs/RELEASE.md)
- [Memory](docs/MEMORY.md)
- [Security](SECURITY.md)

## Attribution

Skoobi Agent was derived from earlier ClaudeClaw/NanoClaw ideas. The public edition keeps that lineage as attribution while using Skoobi Agent as the product identity.
