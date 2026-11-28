# Delegating a task

Use the installed coordinator script with the operator's private `--config`.
`hello` reports capabilities, actual CLI evidence, the requested model profile,
freshness and maintenance. Requested model settings are not provider-reported
model evidence: unavailable reported fields remain null.

## Submit and inspect

Write a private JSON contract. Generate this object with an actual future expiry:

```js
const contract = {
  schema: 1, revision: 1, parentTaskId: 'parent-operation-1',
  projectKey: null, source: {},
  goal: 'Answer the specified question with cited evidence.',
  expectedOutputs: [{name: 'answer.txt', kind: 'document'}],
  acceptance: [
    {id: 'file', kind: 'file_present', outputName: 'answer.txt',
      description: 'The requested answer file is present.'},
    {id: 'quality', kind: 'manual',
      description: 'The answer addresses the question and supports its claims.'},
  ],
  execution: {
    mode: 'isolated', timeoutMs: 900000,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    maxOutputBytes: 8388608, maxWorkspaceBytes: 268435456,
    allowBattery: false, guiAuthorized: false,
  },
  runtime: {model: 'gpt-6-astra', reasoningEffort: 'xhigh'},
  dependsOnParent: false,
};
```

Use the configured worker profile; do not silently change it to pass submission.
`parentTaskId` is a stable operation identifier. Supply `source.operationId` and
`source.messageId` only when they are real admitted identifiers; otherwise leave
`source` empty. `projectKey` is the lowercase canonical memory project, or null.
`dependsOnParent` describes the relationship; the caller waits for required parent
inputs before submitting.

```sh
node /absolute/coordinator/skoobi-peer.mjs submit --config /private/coordinator.json \
  --title 'Research answer' --contract /private/task-contract.json \
  --file /private/task-input.txt < /private/task-prompt.txt
node /absolute/coordinator/skoobi-peer.mjs inspect TASK_ID --config /private/coordinator.json
```

Both `inspect` and `status` read local state without reconciling or dispatching.
The background watcher reconciles; `reconcile TASK_ID` requests an explicit pass.
`accepted:true` means acknowledgement of the matching task, not completion.
Offline submissions retain their identity. Continue independent main work and
report the actual queued or disconnected state.

Send only relevant files (total input limit 8 MiB). The host builds task-specific
canonical memory; do not attach full history, archives, credentials or config.
Inputs live in `inputs/` for isolated execution and `received/` for authorized GUI
execution. Declared outputs and structured `.peer-result.json` go in `output/`.

Acceptance can check text, files, hashes, JSON or existing artifact scenarios.
Presence proves only presence. Use browser/calculation scenarios for functional
checks, and `manual` for judgment. Test user requirements, not worker assertions.

## Corrections, cancellation and review

`revise TASK_ID` reads JSON from stdin with a complete next `contract`, plus
optional `prompt`, `title` and `inputs`. Increment revision by one, retaining
parent and project. Identical retries reuse saved context. Running work records
`interruption_required`; do not claim corrections have applied before their
acknowledgement. Review interrupted work's effects before requesting a new task.

`cancel TASK_ID` records intent immediately. `cancellation_pending` is not proof
of stopping. Inspect the terminal receipt and retained files. If completion wins,
report the actual result together with the late cancellation.

`review TASK_ID` accepts JSON `{decision, resultHash, revision, note}`.
Decision is `accept` or `request_changes`; bind it to the exact assessment hash
and revision and explain the judgment. Acceptance cannot override failed or
unavailable mechanical checks. Manual acceptance is labeled coordinator judgment.
Worker checks, changed objects, limitations and memory proposals remain reports
until independently assessed.

`rework TASK_ID` accepts a complete new submission in JSON: revision 1, same
parent/project, `supersedesJobId`, incremented `rework` (maximum 2), and no later
deadline. Identical retries use one successor. GUI work requires a separately
authorized task after reviewing external effects.

## Extra context and GUI work

An isolated worker may write `.peer-context-request.json` in output with exactly
`query`, `recordKeys` and `reason`. Query and reason are nonempty, at most 1000
UTF-16 characters each; at most 10 distinct record keys, each at most 80 characters.
The host assigns the request ID. Invalid JSON/schema returns a precise bounded
error through `inputs/context-response.json`; repair it in the same execution.
At most three repairs and six accepted requests are allowed. The host pauses that same
process, queries its original scope, supplies an immutable response and resumes.
It does not start a second task. Changed or expired canonical context prevents
acceptance. Memory proposals never write canonical data.

Prefer isolated execution. GUI requires `mode: 'gui'`, `guiAuthorized: true`,
the operator's enabled policy and an explicit bounded allocation:

```sh
node /absolute/coordinator/skoobi-peer.mjs gui-slot TASK_ID --minutes 15 \
  --config /private/coordinator.json
```

The lease binds task and revision. An unlocked owner session and idle desktop
are checked at start. Pause, lock and lease expiry stop work. This does not
distinguish all human interaction from agent input. Do not issue GUI work while
the owner needs that desktop.

## Reading a selected Codex conversation

Use the main agent's `peer_read_codex_history` tool for an explicitly selected
thread ID or exact title and an ISO date window. The host binds a short-lived
request to the verified direct owner's current message and checks it again after
I/O. The peer's `codexHistory` configuration must opt in and point to its canonical
local Codex home. `hello.historyRead` reports configured/pinned API readiness;
a successful read receipt, not installation alone, proves the selected history
store supports the operation.

This is a separate synchronous READ adapter, with a 45-second transport budget,
31-day maximum window and 64-KiB output limit. It uses App Server list/read and
paginated history methods without resume, turn/start, model inference or GUI.
Only the selected conversation's user/assistant text is returned. Attachments,
command outputs, system prompts and unknown-date boundary items are excluded;
known credential patterns are redacted. A partial result states its limit.
Duplicate exact titles fail closed; specify an exact thread ID instead.

The operator must enable this separately; an isolated model cannot inspect the
owner's Codex home. A GUI slot does not grant the runner's direct-owner Codex GUI
authority. Do not forge that capability. Declare task `requiredCapabilities`
when delegation depends on `codex_gui`, `gui` or another supported capability:
missing capabilities stop dispatch before creating a remote execution. Codex
history is available only through the READ tool, not as an isolated task tool.
Read receipts are private, UUID/scope-bound and repeat-safe, capped at 256 retained
requests; operator cleanup or retention policy is needed before that cap is hit.

## Results in the main conversation

The main service receives progress and terminal evidence independently of an
active model turn. Accepted files use its normal router. Do not manually resend
the same files after status inspection. `--no-notify` still imports private
context and receipts but sends no channel messages; reserve it for technical checks.

Use accepted evidence in the combined answer. Report blocked, failed, stale,
unknown-delivery and review-required states explicitly. Process durable memory
proposals under normal main memory rules. Never synchronize databases, sessions,
logins, reminders or Telegram polling between machines.

Use `health --config <absolute coordinator.json>` for a fresh connection observation. It reports the route, worker heartbeat, last contact recorded by a job and queue counts. Use `inspect` for the state and progress of a particular job. Past job receipts keep their original observation times.
