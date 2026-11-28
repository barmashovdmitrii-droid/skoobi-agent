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

## Sandbox policy limits

Before launching an isolated task, Skoobi checks the permission lists and
the serialized settings file. The file can use up to 256 KiB. Each list can
contain up to 1,024 entries, with at most 4,096 entries across the final lists
and 4,096 UTF-8 bytes per entry. If the policy exceeds a limit, the host stops
the task and reports the type of limit in the originating chat. Review
unneeded mount or domain entries and submit the task again after correcting
the configuration. Keep required deny rules in place.

The sandbox runtime still uses Zod 3. These host checks limit the size of
input that reaches its validator. [Dependency advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
