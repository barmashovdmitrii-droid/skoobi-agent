# Optional local search by meaning

Structured memory can combine scoped lexical search with a local multilingual
E5 encoder. The default remains lexical. No cloud embedding API is called and no
model is downloaded during a conversation. This feature does not change the
speech recognition model, engine, or settings.

Run explicit setup from a trusted checkout using Python 3.11 or later, with binary
wheels available for the platform:

```sh
python3 scripts/setup-memory-embeddings.py \
  --target "$HOME/.local/share/skoobi-memory-embeddings"
```

The dedicated target must be outside the code checkout and instance state
directory. Setup creates a separate virtual environment and installs pinned
packages there. It downloads approximately 465 MiB of model/tokenizer data from
the pinned `intfloat/multilingual-e5-small` revision
`614241f622f53c4eeff9890bdc4f31cfecc418b3`. Both files have exact size limits and
upstream SHA256 checks; the offline worker checks them again before loading.
Global Python and speech dependencies are not changed.

To opt in, set these host configuration values using the absolute directory
created above:

```dotenv
SKOOBI_MEMORY_SEMANTIC=local-e5
SKOOBI_MEMORY_EMBEDDINGS_DIR=/absolute/path/to/skoobi-memory-embeddings
```

The normal service loads this configuration; there is no new network listener or
model-facing installation command. Missing, busy, invalid or failed local
inference falls back to lexical retrieval. Removing the opt-in setting restores
lexical-only operation. Existing legacy memory APIs remain available under their
existing scope and forgetting rules.

Only current structured facts in the authenticated tenant, chat and identity are
eligible. The host selects the project first; the encoder receives that project's
facts and global facts, never another project's corpus. Global facts alone are
used when no project is selected. Lexical statistics are also computed within
that same candidate set. Exact name/number matches retain priority. Source quotes
do not prove a fact or grant permission; editorial feedback recalls literal
feedback rather than inferred standing tastes.

Corrections and forgetting invalidate derived vectors and lexical rows in the
same SQLite transaction. Expired records are excluded. After asynchronous
inference, the host checks current rows, revisions, project selection and
tombstones again before building the prompt. A changed or cancelled focus cannot
be revived by a returned cached match. Forgetting still does not erase raw chat
history or independent files.

There is one lazy worker per service, with two CPU threads. Each request embeds
at most 64 uncached facts, uses at most 512 tokens per text and processes four
texts at a time. Each embedding request has a 15-second timeout; a cold recall
may issue one passage request and one query request. Idle workers close after
60 seconds. Concurrent callers use lexical fallback rather than starting extra
model processes. A partially populated vector index is reported as
`hybrid_partial`; missing facts remain eligible for lexical matching.

On one Mac mini, a synthetic maximum batch of 64 long texts took 6.87 seconds and
reached approximately 1.71 GiB peak child RSS. That is a measurement, not an
OS-enforced memory limit or a promise for other machines. A separate held-out
synthetic set returned the intended fact among the first three results for
22 of 40 paraphrases, compared with 0 of 40 for the scoped lexical baseline.
Both methods retained all 16 exact-name/number cases. Warm query P95 was 8 ms and
the initial held-out query took 743 ms on that machine. These are retrieval
measurements on a deliberately paraphrase-heavy set, not universal accuracy or
proof that a subsequent answer/action is correct.

The separate development evaluation is runnable without private conversation
data:

```sh
scripts/with-node22.sh node --import tsx evals/semantic-memory/run.ts \
  --corpus evals/semantic-memory/dev-corpus.json \
  --runtime "$HOME/.local/share/skoobi-memory-embeddings"
```

Build the memory package first when running directly from source. The evaluation
uses a temporary SQLite database and emits record IDs and aggregate metrics.
An optional `--queries` file contains `[{"id":"expected-record-id","query":"..."}]`.
Keep independent evaluation queries separate from model or ranking development.
