# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or an exposed secret.
Use GitHub's private security-advisory flow for this repository.

Include the affected version, impact, reproduction steps, and the smallest
safe proof of concept. Do not include real credentials, private conversations,
or production databases.

## Supported versions

Security fixes are provided for the latest public release. Pre-release builds
are for testing and should not be exposed directly to the internet.

## Secrets and local state

Never commit or publish:

- `.env` files or backups
- API keys, bot tokens, OAuth tokens, or service-account files
- Codex, Claude, browser, SSH, or messaging-session credentials
- `groups/`, `store/`, `data/`, logs, databases, conversations, or media
- Desktop bridge task state or production worktree paths

The example environment file contains placeholders only.

## Trust boundaries

The model is not trusted to decide authority. Stable platform identifiers,
tenant isolation, allowlists, path containment, capability checks, and host
policy must be enforced before any tool or side effect runs.

The optional webhook should stay on localhost unless it is protected by an
authenticated reverse proxy. The optional Desktop bridge must authorize exact
owner commands and dedicated safe worktrees.
