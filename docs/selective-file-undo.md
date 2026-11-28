# Selective file undo

`scripts/task-file-undo.py` edits files in a new isolated copy and keeps a private
journal of the baseline and the bytes written by each operation. It supports a
single-file write, creation, or deletion. It does not intercept arbitrary shell,
GUI, Git, database, message, or API actions.

The tool creates the workspace itself. It cannot register an existing working
installation as an undo target. `init` reads the selected source files and prints
the new task ID and workspace path. Continue work in that returned workspace.

```sh
python3 scripts/task-file-undo.py --state /private/tmp/example-file-tasks init \
  --source /path/to/source --file src/example.ts --file README.md

# Replace the placeholders with IDs returned by this tool.
python3 scripts/task-file-undo.py --state /private/tmp/example-file-tasks edit \
  --task TASK_UUID --file src/example.ts < /path/to/new-content.ts

python3 scripts/task-file-undo.py --state /private/tmp/example-file-tasks undo \
  --task TASK_UUID --operation OPERATION_UUID

python3 scripts/task-file-undo.py --state /private/tmp/example-file-tasks status \
  --task TASK_UUID
```

Use `edit --delete` for a recorded deletion. An optional `--operation-id` makes
repeating the same submission idempotent. Reusing it for different bytes is an
error. `status` recovers interrupted journal updates by comparing actual bytes;
it does not repeat an unknown file mutation.

Undo compares the baseline, the agent's output, and the current file. An unchanged
output can be restored directly. For UTF-8 text, Git's three-way merge can retain
nonoverlapping manual edits while removing the recorded change. Overlapping
edits return `conflict` with the current file intact. A binary file, newly created
file, or deletion needs an exact provable current state. Undo later recorded
edits to the same file first. A second undo of a completed operation is harmless.
The result describes file restoration only; it is not a new build or acceptance
receipt for the restored project.

Safety boundaries:

- Relative paths only; no `..`, `.git`, symlinks, hard links, or special files.
- The workspace identity is pinned. Replacing its directory fails closed.
- Journal intent is persisted before the edit, and the actual result afterward.
- Each file is at most 1 MiB. Initialization copies at most 32 selected files and
  16 MiB. A task has at most 100 operations and a 32 MiB journal; the state root
  has at most 100 tasks. Capacity errors preserve the working files.
- Snapshots expire after 30 days. `status --prune-expired` removes expired
  snapshot bodies while retaining working files and operation metadata.
- Journals and snapshots contain private file contents. Keep the state directory
  outside Git and public exports; the command's output contains metadata only.
- Cooperating commands use an exclusive lock. Paths and file bytes are checked
  before replacement. An unrelated editor writing in the final instant of a
  replacement is not protected by a universal filesystem compare-and-swap.
  Pause concurrent editing while executing the short edit/undo command.

`conflict` exits with code 3; invalid paths, unavailable snapshots, unknown
outcomes and capacity failures exit with code 2. No conflict markers are written
over the user's current file. The caller can show the conflict and preserve it
for a separate deliberate resolution.

Run the synthetic regression suite with:

```sh
python3 scripts/task-file-undo.test.py
```

The suite includes a real child-process exit after a file write but before its
completion receipt, nonoverlapping and conflicting manual changes, binary/new/
deleted files, repeated operations, path escapes and snapshot expiration.
