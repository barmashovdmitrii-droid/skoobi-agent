# Local operation diagnostics

The host assigns a random operation ID to each admitted message. A run links the
exact input IDs selected by the host; a piped correction keeps its own ID and
records when it joined the run. Earlier events in that run do not prove that an
earlier action took the correction into account.

The local SQLite diagnostic tables contain stage names, opaque IDs, times and
bounded numeric metrics. They do not contain messages, transcripts, audio, tool
arguments or results, credentials, file paths, raw chat IDs, or raw CLI tool IDs.
They are independent of the legacy event store, whose payloads are **not** safe
to export wholesale.

The Telegram voice path observes receipt, durable-inbox attempt, metadata lookup,
download, STT queue, conversion and existing recognition/recheck passes. The host
observes materialization, admitted agent queue, execution, observed CLI tools,
response routing, optional artifact acceptance and transport acknowledgement.
This instrumentation does not add recognition passes or change the ASR model.

`model_turn` measures the observed runner turn, including startup and tools. It
does not measure individual provider requests or isolate model inference time.
Nested operations inside a shell script get separate tool observations only when
the CLI exposes corresponding structured events. A completion without an observed
start is labelled `start_unobserved`; no earlier duration is invented.

An API acknowledgement is not proof of human receipt or reading. A transport
timeout has an unknown outcome, even if the remote service might have accepted
the message. Diagnostics never authorize retries or other effects.

On restart the host only interrupts observations whose local owning process is
proven absent. A live/reused PID, permission error or foreign host is left alone.
This assumes a local instance database, not a database shared across machines.
The diagnostic store retains up to 30 days, with hard caps on operations,
attempts and spans. When capacity or storage is unavailable, observations may be
omitted; actual processing continues. Absence of a span is not proof of inactivity.

For a read-only, whitelisted local export:

```sh
node dist/scripts/operation-trace.js \
  --tenant '<tenant>' --chat '<chat>' --message '<message>' \
  --channel telegram
```

The command opens the existing database read-only. It does not initialize or
migrate the instance and never reads legacy event payloads. Scope arguments are
local operator inputs, not an authorization mechanism or a network API. Keep
exports local unless their metadata is appropriate to share.
