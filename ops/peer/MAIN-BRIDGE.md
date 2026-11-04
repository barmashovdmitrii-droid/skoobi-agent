# Main-service context and result bridge

The coordinator calls the built modules under
`packages/core/dist/orchestrator/`. These modules do not initialize the live
database or start services on import. Activate the main inbox with the private
`SKOOBI_PEER_BRIDGE_CONFIG` environment setting after preparing the deployment.

## Private configuration

The JSON configuration has `schema: 1`, `projectRoot`, `root`,
`ownerGroupFolder`, `ownerJid`, `identityId`, `tenantId`, `networkId`, and
`signingKeyPath`. Values are operator configuration, never worker inputs.
All paths are absolute canonical paths. The bridge root is owned by the service
user with mode 0700; configuration and signing key are ordinary single-link
files with mode 0600. The signing key contains at least 32 random bytes and
must remain outside worker task workspaces. Do not commit this configuration.

The main loop checks that the configured owner chat still belongs to the
configured main group and tenant. A changed registration disables processing.
An unavailable channel delays delivery without preventing local receipt.

## Memory API

`peer-bridge-context.js` exports:

```js
await buildPeerContextForCoordinator(configPath, {
  taskId, revision, projectKey, query, expiresAt,
  // Optional supplementary request, limited to the same task scope:
  recordKeys, reason,
});
revalidatePeerContextForCoordinator(configPath, context);
```

The canonical database opens read-only. A context contains only selected
current global facts and the explicit project's records, with source references,
revisions, expiry, and a hash of the scoped canonical revision set. It omits
legacy archives, source quotations, permission notes, credentials, reminder
state, and canonical mutation capabilities. New constraints, corrections,
forgetting, and expiry invalidate earlier context. Read-only supplementary
queries cannot select another identity or project.

The existing local multilingual encoder may rank at most 64 candidates within
a 15-second budget. No cloud fallback is used. Retrieval mode records a lexical
fallback explicitly. Semantic ranking never supplies record bodies: the host
re-reads current canonical rows after encoding. A context is capped at 20
records and 64 KiB; each value is at most 4000 UTF-8 bytes.

## Signed result inbox

`peer-inbox.js` exports `loadPeerBridgeConfig`, `signPeerInboxEvent`, and
`writePeerInboxEvent`. The coordinator durably retains an event before calling
the writer, and reuses the same event ID and bytes after ambiguous publication.
Events are authenticated by HMAC-SHA256 over recursively sorted canonical JSON.

An event has:

- `schema`, `eventId`, `jobId`, `revision`, `parentTaskId`, `projectKey`;
- `receivedAt`, `resultReceivedAt`, `eventKind` (`progress`, `result`, `review`);
- `notify`, `title`, `resultState`, `resultHash`, `contextHash`;
- `contextValidity: {scopeRevisionHash, expiresAt}`;
- `verification: {status, summary, assurance?, mechanicalStatus?}`;
- `summary` and `artifacts: [{name, path, sha256, bytes, kind}]`;
- optional `source: {operationId?, messageId?}` for correlation only;
- optional bounded `workerReport` whose authority is `worker_claims_only`.

Artifacts must be ordinary private files directly inside
`root/artifacts/<jobId>/`, with exact size and hash. The inbox, processed
envelopes, rejected envelopes, and receipts remain private. These paths are
not public release content.

The service imports events into additive `peer_result_events` and
`peer_result_deliveries` tables. Event IDs are immutable, and a semantic identity
also deduplicates `(jobId, revision, eventKind, resultHash)`. Superseded progress
or revisions cannot replace a later terminal result.

Results update an active main run through tagged data without direct-user IDs,
and remain available to the next normal prompt after an idle interval or a
restart. The bridge creates no synthetic user message and issues no memory
write capability. Worker memory proposals remain proposals for main review.
Host reception and assessment run even when no model turn is active.

Before exposing context or sending each part, the service rechecks canonical
revision metadata and expiry. Stale results expose only a `context_stale`
marker, not their text, files, or memory proposals. A newly stale result also
invalidates data already offered to an active run. A channel send already in
flight cannot be retracted by a later correction.

A signed coordinator notice may report cancellation before dispatch or a task
that expired/changed before dispatch. Its two-value `coordinatorNotice` enum
permits only fixed main-generated text, including when context is stale. The
main service ignores all supplied title/body/verification prose and refuses
files or worker proposals on these notices. Deduplication and `notify:false`
still apply, and the receipt retains the true stale context state.

## Delivery semantics

The actual main `MessageRouter` sends notifications and accepted artifacts.
These sends do not acknowledge another active user's message cursor. Files
whose checks failed or remain incomplete stay private for main review. A
coordinator judgment is labeled separately from mechanical verification.

Each part transitions from `pending` to a durable `sending` claim, then to:

- `confirmed`: the channel API returned successfully; this is not human receipt;
- `unknown`: the API threw, timed out, or the service restarted while sending;
- `suppressed`: stale, superseded, rejected, or deliberately not sent.

Unknown outcomes are not retried automatically. A 30-second transport deadline
keeps later local results from waiting indefinitely on one channel call. A
late remote delivery remains possible after such a deadline, so its receipt
continues to say `unknown` rather than inventing failure.

Receipts at `root/receipts/<eventId>.json` bind the job, revision, and result hash,
include `contextState`, and carry per-part states. Aggregate `delivery` is
`pending`, `complete`, `unknown`, `suppressed`, or `disabled`. With `notify:false`,
context is imported and a disabled receipt is written, with zero channel calls.

Optional operation tracing resolves only already admitted operations under the
pinned tenant/chat scope. Peer acceptance, progress, result, assessment, and
delivery stages record bounded metadata; trace IDs grant no authority and raw
task text, errors, file paths, and worker reports never enter these spans.

## Verification

Focused Vitest files cover scoped memory, canonical changes and expiry,
semantic failure, signed inbox and replay behavior, API uncertainty,
artifact integrity, and active/idle/restarted main runs. The main integration
test uses the actual `GroupQueue` and `MessageRouter` with a synthetic channel.

After building, run the offline protocol integration with Node 22:

```sh
bash scripts/with-node22.sh node --test ops/peer/skoobi-peer.integration.node-test.mjs
```

It exercises the real coordinator, RPC store, worker result collection, host
checks, signed main inbox, no-notify receipt, and remote result acknowledgment.
Only the model producer and native-runtime handshake are fixtures; this is not
a claim that a native model ran. Separate native containment checks remain
required before deployment.
