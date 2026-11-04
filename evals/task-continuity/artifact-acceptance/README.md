# Host artifact acceptance

This synthetic evaluation exercises the shipped verifier, host contract registry
and delivery snapshot policy. It is not a model/prompt score and sends no messages.

The good ZIP is extracted to a fresh directory, opened in a real headless Chromium
context, navigated with a button, and completed using Enter. The broken ZIP still
contains every source file, but its entry references a missing script. File-list
checks would miss that packaging defect; the actual browser journey fails.

## Running

Use an isolated checkout, never the directory of a running service. Install the
locked development dependencies and the matching Chromium build there:

```sh
npm ci
npx playwright install chromium
npm run build:packages
node evals/task-continuity/artifact-acceptance/run.mjs
npm test -- packages/core/src/orchestrator/artifact-acceptance.test.ts packages/core/src/orchestrator/artifact-acceptance-policy.test.ts
```

Use the project's Node 22 wrapper where Node 22 is not the default. A Linux CI
image may also need Playwright's documented browser system dependencies. The real
browser tests fail when those prerequisites are missing; the runtime API returns
`inconclusive`, never a successful verification. The standalone evaluation prints
only synthetic outcome metadata and removes its temporary data.

## Host workflow and delivery

The separately compiled `dist/scripts/artifact-acceptance.js` supports `prepare`,
`register`, `check` and `verify`; `--help` lists the arguments. `prepare` explicitly
copies the pinned checker to private host state outside the instance; normal
service startup only calculates the configuration and creates nothing. The
default state path is a per-instance directory beneath `~/.skoobi-host-checks`.
The ordinary `check` command cannot mint a producer attestation. Use
`dist/scripts/artifact-job.js --help` for the explicit macOS job workflow: a
host-approved JSON job supplies readonly inputs, requirements and an offline
producer command or the selected instance's configured Codex model. The whole
producer starts inside Seatbelt; only successful containment preflight followed
by actual output checking can produce a signed receipt. The CLI copies successful
output to a new destination and binds its receipt to the host-approved contract.
Registration is a host action, with no model-facing IPC route. Changed criteria
clear the previous receipt. A caller flag or model JSON cannot mint attestation.

The delivery policy returns `required:false` for an unregistered artifact.
For a registered artifact it checks a host-private copy against the signed receipt
and returns that copy as `snapshotPath`. The transport must send the snapshot,
preserve the intended display filename separately, and call `cleanup()` in a
`finally` block. Checking the original path and later opening it asynchronously
would leave a race. Snapshot creation is bounded; interrupted scratch directories
expire and an excessive backlog refuses additional checks.

Receipts bind archive bytes, criteria, optional caller-maintained source digests,
validator version, checker digest and browser runtime fingerprint (Chromium executable/framework, Playwright JavaScript/package metadata, Node and Python). A changed runtime requires another check. The caller must recalculate source digests
when its inputs change; this pilot does not discover arbitrary dependencies.
Delivery and human approval are explicitly `not_recorded`. A browser success is
evidence for only the named assertions, not usability, artistic quality or a
general guarantee about the application.

## Trust and resource boundaries

`boundary` is legacy metadata and never authorizes signing. The controller
mints a one-use in-process token only after an actual macOS Seatbelt launch,
checks its output hash and requirements binding, and passes it directly to the
host signer. Receipts record the profile policy/digest, executable and output
hashes. A retained authentic receipt can be verified later by the ordinary host.
Direct full-access production cannot produce a new receipt. Unsupported OS,
missing sandbox/Python/viewer capabilities or failed probes return inconclusive.

Fifteen preflight checks cover protected reads/writes (including the Data-volume alias), immutable inputs, rename, symlink/hardlink access,
child inheritance, a nested permissive sandbox, AppleScript, LaunchServices,
a host Unix socket and an unrelated local port. It also queries the actual OS
`job-creation` and preference-write sandbox authority; read-only `launchctl print` alone would not test
launch authority. No system job is created. The profile grants no app-launch Mach lookup, Apple Events or general network. The Codex variant allows only its mandatory read-only preference domain through cfprefsd and read-only invalidation counters; preference writes remain denied. TLS uses the system CA PEM without keychain access. Codex receives private temporary auth and fresh
configuration without ordinary MCP/plugins, and a CONNECT-only proxy permits
only exact `chatgpt.com`, `api.openai.com` and `auth.openai.com` TLS hosts on port443 with checked public DNS addresses. Other destinations, malformed authorities and direct connections are denied. All
proxy sockets are destroyed at job end. Mandatory system Codex requirements
remain readable and are not bypassed.

The performing producer cannot read or write the host key, checker or registry.
This does not protect against a separate malicious owner process, an OS/browser
exploit, or all CPU/memory exhaustion. Native sandbox APIs are platform-sensitive;
preflight failure refuses attestation rather than falling back. Process-group
termination is not a universal daemon/cgroup resource boundary. Ordinary owner
conversation permissions are unchanged.

ZIP inputs are capped at 16 MiB, 256 members, 8 MiB/member and 32 MiB expanded.
Traversal, symlinks, special/encrypted members, case-normalization collisions and
excessive compression ratios are rejected. Extraction never executes archive
commands. The browser uses a fresh context, no credentials or service workers,
a loopback file server, restrictive CSP, and blocked external HTTP/WebSocket
requests. This is for self-contained browser bundles; applications needing
external services or unsupported capabilities do not pass this pilot. It is not
an OS network sandbox for arbitrary hostile browser exploits.

Checks have a 20-second deadline plus a short shutdown grace. Node heap and archive
buffers are capped, but this does not impose a hard total Chromium RSS quota.
Failure traces can contain page/network contents: keep them private. Retention is
seven days, at most 128 receipts and eight traces, with an 8 MiB per-trace cap.
Trace existence is not itself a passed assertion. User-facing logs should record
only statuses and opaque receipt IDs, never trace contents or artifact paths.

Primary API references:

- https://playwright.dev/docs/api/class-browsercontext
- https://playwright.dev/docs/api/class-tracing
- https://playwright.dev/docs/trace-viewer

## Minimal offline job

After building and preparing the checker, create a host-approved JSON job with
`requirements` from `requirements.json`, `inputs: [{"sourcePath":"source.zip",
"relativePath":"source.zip"}]`, `artifactRelativePath: "output/artifact.zip"`,
and a producer executable such as an absolute Node path with args:
`["-e", "require('fs').copyFileSync('inputs/source.zip','output/artifact.zip')"]`.
Run `artifact-job.js --job approved-job.json --output new-bundle.zip`. The copy is
a containment demonstration; production jobs should use their actual producer.
For Codex use `producer: {"kind":"codex", "authJsonPath":"/protected/auth.json",
"promptFile":"task.txt"}` instead. The selected instance must already have its
configured, integrity-checked native toolchain and matching code-mode helper.
No toolchain installation, service restart or real message is performed by this CLI.
Temporary credentials and the producer workspace are removed on normal completion, failure and timeout. A forcibly killed or crashed host may leave a private temporary directory; this pilot does not claim crash-proof credential erasure.

Primary isolation/configuration references:

- https://github.com/apple-oss-distributions/launchd/blob/main/src/core.c (job-creation authorization)
- https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/macos.rs (mandatory managed preferences)
- https://github.com/openai/codex/blob/main/codex-rs/http-client/README.md (proxy and CA handling)

The public repository does not include an operator-specific Codex toolchain pin.
Codex job mode requires an explicit local native installation, its integrity
manifest and the selected instance's configured launcher. Without them it is
unavailable; the CLI never downloads or chooses another model/toolchain. The
ordinary public installer and provider setup remain independent of this opt-in
artifact workflow. An attestation covers only the launched producer, not an
earlier full-access author or a separate process that can modify host authority.
