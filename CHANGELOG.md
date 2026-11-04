# Changelog

All notable public changes to Skoobi Agent are documented here.

## 2.3.0

- Added an optional coordinated macOS worker with durable task identities,
  explicit requirements, revision acknowledgements, cancellation, bounded
  execution and independent host acceptance of exact returned files.
- Added scoped, expiring structured-memory exports and supplemental context.
  Corrections and forgetting invalidate old results; worker memory proposals
  remain read-only data for the main assistant to review.
- Routed peer progress and results through the main service's signed durable
  inbox. Receipts distinguish confirmed API delivery, disabled notifications
  and unknown outcomes; uncertain sends are not automatically replayed.
- Added staged worker deployment, native build receipts, crash recovery and
  rollback. The optional MacBook worker uses a reviewed macOS arm64 CLI pin;
  the generic installer and global CLI selection remain unchanged.
- Kept private credentials, local configuration, conversations, host identities,
  generated results and private Git history outside the public source update.

## 2.2.0

- Added bounded operation timelines linking admitted messages, queued work,
  model/tool attempts and transport outcomes. Diagnostics do not treat API
  acknowledgement as human acceptance or replay uncertain external actions.
- Made Telegram audio intake durable across interruptions, with ordered
  materialization, cancellation and bounded technical retries. Suspicious
  transcripts can receive a bounded recheck using the existing speech model.
- Added an opt-in artifact contract and a macOS producer sandbox with host-run
  browser scenarios, exact-byte receipts and protected delivery snapshots.
  Ordinary full-access runs cannot declare themselves isolated; unsupported
  environments and missing required tools remain explicitly inconclusive.
- Added a strict PDF/XLSX calculation reconciliation pilot with page/cell
  evidence, exact decimal arithmetic, independent formula checks and final-file
  rendering. This does not certify arbitrary layouts or financial correctness.
- Added source-linked editorial feedback, read-only project comparisons and
  optional local semantic recall. Search remains scoped to current authorized
  records; corrections and forgetting invalidate derived indexes. Embedding
  setup is explicit and does not change speech recognition.
- Added reproducible skill verification, scoped file undo and a resumable
  private feature-branch update helper. File undo does not reverse messages,
  payments or other external actions; public export remains a separate review.
- Preserved public installation safeguards, optional accounting interfaces,
  dependency security overrides and existing data. New fixtures are synthetic;
  operator-specific model pins and private runtime state are not distributed.

## 2.1.1

- Fixed structured memory writes from Telegram messages whose durable cursor
  includes sub-millisecond precision. Source timestamps are normalized without
  changing the original message cursor.
- Preserved message-ID ordering for corrections received in the same
  millisecond, and rejected invalid source timestamps.

## 2.1.0

- Added scoped project cards, versioned decisions, source quotations, expiry,
  and explicit forgetting to structured memory. Reads are paginated; structured
  memory tool requests and responses are authenticated and encrypted in local IPC.
- Improved task continuity after corrections, interrupted runs, and short
  follow-up messages. Background progress cannot replace the user's current
  project focus, and old updates cannot overwrite newer direct decisions.
- Updated transitive `shell-quote` and `proxy-addr` dependencies to versions
  containing their critical security fixes.
- Added bounded relevant-memory recall and clearer Telegram progress delivery.
- Updated Desktop task result handling, local-file delivery checks, scheduled
  task recovery, and run diagnostics.
- Preserved existing public installation and upgrade safeguards, optional
  accounting interfaces, and stored user data. Runtime telemetry no longer
  presents subscription token counts as an API spending estimate.
- Kept deployment-specific operations, runtime state, private reports, and
  private Git history outside the public update. Examples and test fixtures
  use synthetic identities.

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
