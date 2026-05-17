# Changelog

All notable changes to Skoobi Agent will be documented here.

## 1.2.18 - 2026-05-17

Follow-up audit cleanup: portability, supply chain, legacy alias shim.

- Typecheck now covers `setup/` via a dedicated `tsconfig.typecheck.json`; caught a stale `.ts` import extension in `setup/register.ts` that the previous src-only check missed.
- Dependency tree pins `postcss` to `^8.5.10` via `overrides`, removing the moderate XSS advisory (CVE GHSA-qx2v-qp2m-jg93). `npm audit` reports 0 vulnerabilities.
- CI matrix runs on both `macos-latest` and `ubuntu-latest` with `fail-fast: false`, so the Linux install path documented in the README is exercised on every push.
- Workflows set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`, opting marketplace actions into the Node.js 24 runtime ahead of the September 2026 deprecation deadline (closes #5).
- New `src/lib/binary-paths.ts` resolves `ffmpeg`, `ffprobe`, and `whisper-cli` via `which` first, then Apple Silicon, Intel macOS, and Linux fallbacks; replaces the previous Apple-Silicon-only hardcoded defaults in `src/tts.ts`, `src/transcription.ts`, and `src/video-telegram.ts`.
- Installer launchd plist and systemd unit now prepend the directory of the install-time `node` binary to the service `PATH`, so non-Homebrew node installs (Intel macOS, asdf, nvm, Linux package managers) start with a working `node` on PATH instead of relying on `/opt/homebrew/opt/node@22/bin`.
- `setup/service.ts` (alt-installer) and `selftest` PATH in `src/channels/telegram.ts` use the same dynamic node bin directory.
- Legacy `CLAUDECLAW_*` environment variables now have `SKOOBI_*` aliases (`SKOOBI_ENV_FILE`, `SKOOBI_GROUP_DIR`, `SKOOBI_IPC_DIR`, `SKOOBI_PROJECT_DIR`, `SKOOBI_GLOBAL_DIR`, `SKOOBI_EXTRA_DIR`, `SKOOBI_EXTRA_DIRS`, `SKOOBI_RUNNER_IDLE_WAIT_MS`). New name takes precedence; the legacy name remains a fallback so existing host-side launchers keep working without manual migration.
- Mount and sender allowlists are looked up under `~/.config/skoobi/` first, then under the legacy `~/.config/claudeclaw/` directory. Fresh installs land on the skoobi path.

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
