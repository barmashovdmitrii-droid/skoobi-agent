# Coordinated MacBook worker

Protocol 2 connects one main assistant to a separately authenticated worker.
The main service owns the conversation, canonical memory, schedules and result
delivery. The worker executes bounded tasks and returns evidence. It does not
poll Telegram or merge its memory into the main database.

See [task operations](TASKS.md), [main memory and delivery](MAIN-BRIDGE.md), and
[deployment and recovery](DEPLOYMENT.md). Private configuration, keys, state,
logs, memory contexts and generated artifacts never belong in this directory.

## Reliability contract

- Record a task identity before contacting the worker. Retries preserve exact
  input, revision and context hashes; they cannot start a copy.
- Submission, execution, verification and delivery are distinct states. A
  completed process or worker assertion is not proof of acceptance.
- Corrections have explicit revisions and acknowledgements. Running work stops
  before revised requirements can take effect. Completion winning that race
  requires review against the new requirements.
- Cancellation intent is durable during a blocked network call. Only a matching
  terminal receipt confirms remote cancellation. A task never submitted can be
  cancelled locally; ambiguous submissions never get a new identity automatically.
- Scoped, expiring memory replaces whole-memory snapshots. The main host
  revalidates canonical facts before sending, accepting and delivering results.
  Extra context is bounded to the same authority and project.
- Main delivery uses a signed inbox and durable per-part receipts. Ambiguous
  channel delivery stays unknown and is not automatically repeated.
- Interrupted tasks preserve partial evidence. Rework uses one durable successor,
  at most two attempts, explicit acceptance and a shared deadline.
- Queue, workspace, time and output limits are enforced. Isolated execution uses
  existing macOS containment checks and private per-task authentication copies.
  GUI work requires an explicit lease and records its broader authority.

Protocol-1 jobs remain inspectable history. A protocol-2 coordinator requires
the upgraded worker's capabilities and actual pinned runtime before dispatch.
Migration does not resubmit historical jobs.

## Verification

Use an isolated source checkout and Node 22; build before compiled integration:

```sh
npm run build
npm run typecheck
npm test
bash scripts/with-node22.sh node --test ops/peer/*.node-test.mjs
```

Suites cover actual kernel lock release after process death, durable state,
revision and cancellation races, context invalidation, exact artifact transfer,
main routing with a synthetic channel, and deployment crash recovery. Offline
model producers are fixtures. A separate native containment and Codex smoke is
required before activating a release; it must suppress channel messages.

Builds and tests must not use an active service checkout or live credentials.
Deployment checks exact source, build receipts and installed hashes; it preserves
the worker's own login, global tools, private state and historical jobs.

## Optional platform pin

`runtime/codex-toolchain.json` and `scripts/codex-toolchain.mjs` belong to this
optional macOS arm64 worker. They contain only official registry URLs and
reviewed package hashes. They do not change the generic installer, replace a
global CLI, or select the owner's model. Configure the worker explicitly and
complete the staged native checks before activation.
