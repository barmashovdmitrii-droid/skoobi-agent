# Updating a headless MacBook peer

The peer is an executor plus its existing helper, not a second Telegram service.
The Mac mini owns scheduling, canonical memory and the user conversation. Never
run a general installer, `npm install`, a build, or tests inside either live
instance. Never use an ordinary delegated job to update the worker itself.

## Scope and trust

These tools are operated by the owner over a separate, already authorized
maintenance SSH connection. Keep the purpose-bound task RPC key restricted.
Pin the known host key; an SSH alias can inherit a different `HostKeyAlias`, so
check the final lookup against the known peer identity rather than accepting a
new key. The tools do not install a key, alter SSH configuration, modify login,
change GUI permissions, change sleep settings, or create a Telegram consumer.

Code is generic. Every inventory, plan, receipt, log, backup and source bundle
belongs in a private directory outside Git (directory mode 0700, file mode 0600).
This is an operator workflow for a cooperative, quiesced machine. It is not a
security boundary against another process with the same operating-system UID.
An operator receipt records an observed check; it is not a cryptographic oracle.

## Build and compatibility

1. Review and commit the candidate in an isolated checkout. The bundle builder
   rejects a dirty checkout. `pack` exports an explicit code allowlist; it never
   takes the live directory or its history, groups, SQLite, secrets or credentials.
2. Pass the independently reviewed runtime manifest. This rollout pins the
   managed Codex CLI to **0.166.0** on macOS arm64. The source repository may still
   have an older default manifest; the explicit overlay is part of the receipt.
   A code update preserves the worker's existing model and reasoning settings.
3. Transfer the bundle, matching builders, and receipt through maintenance SSH.
   `build` extracts into a new directory on the target, uses an isolated HOME and
   package cache, installs locked dependencies, checks the pinned native CLI,
   installs a local browser, builds and runs the complete suite plus peer tests.
   It does not call a model or start a service. Logs, runtime, exit status and the
   entire prepared tree are bound into the resulting receipt. Failures stop the
   build; there is no skip-checks or force-success mode.
4. `runtime/peer-release.json` identifies the source commit/archive and exact
   bridge files and CLI. The worker checks the observable bridge/runtime before
   reporting a source revision. The controller binds the complete release tree,
   not just this small metadata file. The prepared release stays at its path;
   do not move it after building or mutate it after preparation.

```sh
python3 ops/peer/peer-release.py pack \
  --source '<clean-checkout>' --commit '<reviewed-40-character-commit>' \
  --output '<empty-private-bundle-directory>' \
  --toolchain '<reviewed-native-manifest>'

python3 '<reviewed-tools>/peer-release.py' build \
  --bundle '<private-bundle-directory>' --stage '<new-private-stage>' \
  --node '<existing-pinned-node22-binary>'
```

The worker export supplies `scripts/skoobi-peer-worker.mjs` as the compatibility
entrypoint. Existing launchd arguments and the forced SSH command keep their
stable path. Protocol 2 rejects incompatible *new* jobs. Protocol 1 history is
readable, but unfinished legacy jobs must be reviewed rather than executed by
guessing. Update the compatible Mini coordinator with delegation disabled first;
enable it only after the new worker, native checks and quiet smoke pass.

## Prepare without changing the live installation

```sh
python3 '<reviewed-tools>/peer-deployment.py' inventory \
  --root '<live-worker-root>' --output '<private-audit>/inventory.json'

python3 '<reviewed-tools>/peer-deployment.py' prepare \
  --root '<live-worker-root>' --release '<new-private-stage>/release' \
  --receipt '<new-private-stage>/release-receipt.private.json' \
  --plan '<private-deployment>/plan.json'
```

Preparation checks root/owner, service identities, Node, own-user authentication,
local changes/collisions, internal symlinks, the exact native build receipt and
every release byte. It stores the current code/configuration hashes. It changes
no live code, environment, service or job. Source symlinks must stay inside the
allowlisted archive; package/workspace links must remain inside the release.

For an owner peer whose GUI capability is already approved, `prepare --enable-gui`
retains that capability in the new worker configuration. It does not grant a
screen slot or change OS permissions: each GUI task still needs its declared mode,
explicit authorization and a separate short-lived exclusive slot. Without this
option, the controller preserves the existing `allowGui` setting.

## Quiesce and switch

Stop the Mini producer's acceptance of new work and stop its coordinator watcher
after recording a fresh quiescence receipt. The receipt has:

```json
{"status":"quiesced","newSubmissionsAllowed":false,"checkedAt":0}
```

`checkedAt` is the observed Unix time in seconds, not a fabricated placeholder.
The controller requires it to be less than two minutes old. Keep that producer
stopped throughout activation and smoke. Manually submitting a job during this
window violates the maintenance procedure.

```sh
python3 '<reviewed-tools>/peer-deployment.py' activate \
  --plan '<private-deployment>/plan.json' \
  --coordinator-receipt '<private-deployment>/coordinator-quiesced.json'
```

The controller:

- Rechecks every bound byte and requires an idle queue/heartbeat. It writes a
  persistent maintenance gate; new protocol-2 submissions stop at this gate.
  An expired gate remains closed until the controller verifies and removes it.
- Stops only the recorded worker and helper jobs. The initial legacy worker
  does not understand the gate, so quiescing its Mini producer is mandatory.
- Backs up configuration, launch agents, the consistent SQLite database and peer
  job/context/artifact state. It retains the original code separately.
- Converts only the reviewed code entries to links through one stable
  `.peer-code-current` pointer. Conversion is journaled while services are down;
  future activations switch that single pointer atomically. Private state stays
  in the original live root. Unknown root files are preserved.
- Changes only worker `protocol`, its managed CLI path and the reference to its
  **own** authentication file. The `.env` CLI binding is changed with a byte
  compare-and-replace. If the release contains its browser, the two existing
  services receive a `PLAYWRIGHT_BROWSERS_PATH` pointing into that release.
  Global Codex, its login, other configuration and GUI permissions are retained.
- The helper resolves its private environment and log directory from the existing
  absolute `CLAUDECLAW_ENV_FILE` service setting. It validates a canonical owned
  instance and a private regular environment file. An invalid explicit path fails
  closed; it never falls back to a release directory or global configuration.
  Installations without that setting retain the original module-relative layout.
- Starts the two existing services and requires new process IDs plus a matching,
  idle heartbeat. The maintenance gate remains closed.

The controller never restarts the Mini primary service and never invents a
scheduled launchd job. On an exception it leaves its journal and gate available;
do not blindly rerun activation. Inspect and use the guarded rollback.

## Verify, smoke, resume

Before removing maintenance, independently verify read-only RPC health, exact
CLI and bridge hashes, configuration preservation, the isolated smoke checks,
fresh heartbeat, and no Telegram polling. Save a private validation receipt with
the `releaseTreeSha256` from the plan and true values only for the observed
`actualRuntimeVerified`, `rpcHealthVerified`, `configurationPreserved` and
`isolatedSmokePassed` checks.

```sh
python3 '<reviewed-tools>/peer-deployment.py' release-maintenance \
  --plan '<private-deployment>/plan.json' --validation '<health-receipt>'
```

This yields `smoke_ready`, not deployed, and does **not** resume Mini. Submit one
bounded harmless protocol-2 task with `notify=false`, synthetic input and known
artifact criteria. Do not send a real message as a hidden delivery probe.
Record the actual result and exact artifact verification with the same release
hash plus `quietSmokePassed`, `notifyDisabled`, `artifactCriteriaPassed` and
`noExternalDelivery`. Then:

```sh
python3 '<reviewed-tools>/peer-deployment.py' complete \
  --plan '<private-deployment>/plan.json' --validation '<quiet-smoke-receipt>'
```

Only now resume the compatible coordinator, preserving its durable queue,
cancellation markers, inbox and delivery receipts. Validate its expected runtime
tuple against the worker's observed CLI/bridge hashes before delegation.

## Recovery and rollback

```sh
python3 '<reviewed-tools>/peer-deployment.py' rollback \
  --plan '<private-deployment>/plan.json'
```

Rollback restores code and only configuration bytes written by this deployment.
It refuses late user edits, a changed previous release, active work or collisions.
The journal handles an interrupted initial conversion, including a crash between
moving old code and publishing its replacement link. **It never restores live
SQLite or peer job state from backup**; new user data and results survive.

For the first protocol-1 → protocol-2 cutover, legacy rollback is permitted only
while job history is unchanged. Once any new/changed protocol-2 job exists, the
controller refuses to restart the legacy worker. Use a verified compatible
protocol-2 recovery release; retain the queue/gate and inspect unresolved external
effects. Restoring old bytes is not permission to replay tasks. The historical
database backup is available for a separate reviewed recovery if needed.

The checked release, previous code, logs and private backup must be kept through
the observation period. Do not delete them as automatic build cleanup.

## Regression checks

`peer-deployment.test.py` uses disposable roots and a synthetic launchd adapter.
It verifies release mutation and symlink rejection, late edits, quiescence, exact
configuration changes, state-preserving rollback, incompatible history refusal,
interrupted conversion, and an actual separate-process lock/crash. The release
tests check archive traversal/links, private-state exclusion, a real failed
command and bounded process-group timeout. No test contacts either live host.
