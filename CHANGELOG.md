# Changelog

All notable public changes to Skoobi Agent are documented here.

## 2.0.0

- Added one fail-closed operation lock shared by install, update, uninstall,
  and owner initialization. A lock is recovered only when its process identity
  is proven stale; active or uncertain locks remain protected.
- Added early non-terminal input checks, strict Telegram token parsing, and a
  live `getMe` authentication check before service activation.
- Preserved the selected provider, custom OpenAI-compatible base URL, and
  pinned Codex executable during token-only reconfiguration.
- Fixed managed CLI cleanup when an installation prefix has a symlinked
  ancestor, while continuing to preserve foreign or relative CLI links.
- Cleared failed Telegram startup state so health checks do not report a
  rejected bot connection as connected.
- Added regression coverage for stale and active cross-runtime locks,
  unattended input, provider preservation, Telegram preflight, and lifecycle
  cleanup.

## 2.0.0-rc.3

- Fixed managed Linux service generation and added systemd unit validation.
- Prevented installer-generated Husky files from blocking reinstall, update,
  or uninstall while continuing to protect owner-modified files.
- Fixed application path handling for home directories containing spaces or
  non-ASCII characters.
- Made low-level updates fail closed unless both an exact ref and commit ID are
  supplied; normal upgrades use the checksum-verified release installer.
- Quiesced managed services before release swaps and improved failed-install
  and failed-update rollback, including signals and partially completed file
  operations.
- Made launchd state checks fail closed on manager/transport errors and added
  Linux journal output to `skoobi logs`.
- Corrected extension discovery from the built workspace package layout.
- Added per-instance backup cleanup and Linux lingering guidance.

## 2.0.0-rc.2

- Fixed the clean-install Telegram token prompt and CLI link creation.
- Added a fail-closed, idempotent first-owner bootstrap command.
- Routed default Codex turns only for the registered owner tenant.
- Verified the pinned sandbox runtime without `npx` or network resolution.
- Expanded dependency, authentication, owner, and runtime health checks.
- Added an English five-minute Quick Start and troubleshooting guide.
- Documented the required explicit rc.1 Codex-profile reconfiguration; a
  normal update continues to preserve the existing private `.env`.

## 2.0.0-rc.1

- Reorganized the runtime into workspace packages.
- Added optional WhatsApp, dashboard, Google Workspace, and Desktop bridge
  components behind explicit configuration and authority checks.
- Expanded runtime isolation, tenant protection, safe file handling, and
  regression coverage.
- Kept runtime data, credentials, private operations, and private Git history
  outside the public source export.

Historical note: `2.0.0-rc.1` starts a clean public-source history. Earlier
`1.2.x` tags came from a different publication process and are retired as part
of the privacy-hardening cutover.
