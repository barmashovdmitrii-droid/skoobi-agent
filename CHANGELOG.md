# Changelog

All notable changes to Skoobi Agent will be documented here.

## 1.2.17 - 2026-05-17

Bug-fix release closing audit findings against 1.2.16.

- Installer healthcheck now correctly detects `store/messages.db` (previously checked a literal path with broken string concatenation and always reported "DB not created yet").
- Webhook server adds per-IP rate limit and body size cap before HMAC verification so anonymous traffic cannot exhaust memory or poison the per-group rate limiter for known group folders.
- Webhook server moves the per-group rate limit to after HMAC verification so only authenticated callers can throttle a group.
- Codex CLI failure classifier now matches HTTP 5xx via `\b5\d{2}\b` instead of the substring `" 5"`, which previously misclassified unrelated stderr containing digits or spaced "5".
- `skoobi logs` no longer prints `service.out.log` and `service.err.log` twice.
- Agent runner full-access directory list no longer includes the post-export placeholder `/Users/example`.

## 1.2.16 - 2026-05-17

Public repository hygiene release.

- Removed internal readiness report from public source.
- Replaced inherited upstream changelog content with Skoobi Agent public changelog.
- Cleaned public CI branch configuration.
- Cleaned public documentation commands for Node.js 22 usage.
- Kept release installer pinned to the release tag.

## 1.2.15 - 2026-05-17

First stable public installer release.

- Release installer is pinned to the release tag.
- Added public GitHub release installer.
- Added app/instance install layout.
- Added Skoobi Agent public documentation.
- Added checksum verification for install.sh.

## 1.2.14 - 2026-05-17

Superseded initial public release.

- Initial public release.
- Superseded by 1.2.15 because the installer asset was not pinned to the release tag.

## Attribution

Skoobi Agent was derived from ClaudeClaw/NanoClaw ideas. Historical compatibility identifiers may still appear in code, but the public product identity is Skoobi Agent.
