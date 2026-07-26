# Skoobi Agent

Skoobi Agent is a self-hosted, Telegram-first assistant runtime. It provides
tenant isolation, local memory, scheduled tasks, tool policy, optional Codex
CLI execution, voice features, and local integrations.

This repository contains source code only. Runtime state, conversations,
credentials, databases, logs, and local authentication files do not belong in
Git.

## Status

The `2.0.0` line is a major architecture update. It introduces workspace
packages for the core, channels, providers, memory, voice, billing, payments,
and dashboard. Review the release notes before upgrading an older installation.

## Requirements

- macOS or Linux
- Node.js 22 or newer
- npm
- git
- ripgrep (`rg`)
- the `sqlite3` command-line tool for managed installs
- native build support if a dependency has no prebuilt binary for your platform
- a Telegram bot token
- optional: an authenticated local Codex CLI

## Managed install

For a persistent instance with code and runtime state kept separately, follow
[docs/INSTALL.md](docs/INSTALL.md). The managed installer verifies an exact Git
commit and creates an instance under `~/.skoobi/instances/`. A normal rerun
preserves the existing `.env`; changing instance configuration requires the
explicit `--reconfigure` flag.

## Build from source

```bash
git clone https://github.com/barmashovdmitrii-droid/skoobi-agent.git
cd skoobi-agent
npm ci
npm ci --prefix agent/runner
npm run build
```

Create a separate development state directory, copy the example environment,
and add the Telegram token plus the stable Telegram user IDs that may
administer the instance:

```bash
APP_DIR="$PWD"
STATE_ROOT="$HOME/.skoobi/dev/default"
mkdir -p "$STATE_ROOT"/{groups,store,logs,data}
cp .env.example "$STATE_ROOT/.env"
# Edit "$STATE_ROOT/.env", then:
(cd "$STATE_ROOT" && node "$APP_DIR/dist/service.js")
```

This source-mode state directory is for development. Use the managed installer
for a long-running service.

## Development checks

```bash
npm ci
npm ci --prefix agent/runner
npm test
npm run typecheck
npm run build
```

The root build also compiles workspace packages, applications, and the agent
runner.

## Security boundaries

- Display names and usernames are not identity.
- Guest tenants must not read owner or other-tenant memory.
- Runtime state stays outside the source tree and is denied to guest tools.
- Credentials must come from the local environment or protected files.
- The model is not a security boundary; host policy decides tool authority.
- Owner-only actions remain fail-closed and require stable owner identity.
- The optional Desktop bridge accepts only explicitly authorized worktrees.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.

## Optional components

- Telegram and WhatsApp channels
- local speech-to-text and text-to-speech
- Codex CLI provider
- Google Workspace broker
- local dashboard
- Codex Desktop bridge
- webhook triggers
- billing and payment modules

Optional components are disabled until explicitly configured.
The payments package exposes provider-neutral extension ports only: this
repository ships neither a network payment adapter nor a paid catalog, and the
Telegram sales flow remains disabled until a host application deliberately
supplies and wires both.

## Repository hygiene

Never commit `.env`, credentials, chat history, `groups/`, `store/`, `data/`,
logs, local models, Desktop task state, or authentication/session files. Use
the placeholders in `.env.example`.

## Documentation

- [Install](docs/INSTALL.md)
- [Memory and privacy](docs/MEMORY.md)
- [Release process](docs/RELEASE.md)
- [Roadmap](docs/ROADMAP.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Attribution

Skoobi Agent grew from ClaudeClaw and NanoClaw ideas. Upstream copyright and
license notices are retained in [LICENSE](LICENSE).
