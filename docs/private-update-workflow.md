# Resumable private feature-branch update

`scripts/private-update-workflow.py` runs one fixed operator workflow on macOS or
Linux. It prepares a clean copy, installs locked dependencies, builds, checks
Typescript, runs tests and shell syntax checks, scans the tracked tree and new
commits, then publishes an exact commit only when `publish` is invoked. It does
not restart a service, merge, tag, release, or export a public repository.

Requirements: Python 3.10+, Git, authenticated `gh`, Gitleaks, and Node 22 supported
by `scripts/with-node22.sh`. The workflow records their versions. Run this helper
from a trusted checkout. State must be outside the source and its working copy.
Do not put journals or logs into Git.

```sh
python3 scripts/private-update-workflow.py --state "$HOME/.local/state/skoobi-update" prepare \
  --source /path/to/clean-source --repo OWNER/PRIVATE_REPOSITORY --branch feature/runtime-update
# The JSON response supplies TASK_ID and an isolated workspace.
python3 scripts/private-update-workflow.py --state "$HOME/.local/state/skoobi-update" run TASK_ID
python3 scripts/private-update-workflow.py --state "$HOME/.local/state/skoobi-update" status TASK_ID
python3 scripts/private-update-workflow.py --state "$HOME/.local/state/skoobi-update" resume TASK_ID
python3 scripts/private-update-workflow.py --state "$HOME/.local/state/skoobi-update" publish TASK_ID
# Permanent cancellation of this workflow:
python3 scripts/private-update-workflow.py --state "$HOME/.local/state/skoobi-update" cancel TASK_ID
```

For a new feature branch based on an approved branch that differs from the
repository default, add `--base-ref prod` to `prepare`. This names only the
read-only starting branch: its exact remote commit must be an ancestor of the
source HEAD, and its branch name and commit are recorded. The publication target
remains the separately supplied feature branch; it cannot equal `--base-ref`.
If that feature branch already exists remotely, its current commit remains the
required base and expected publication OID. Without the option, the default
branch remains the base for a new feature branch.

The source is read and cloned, never installed, built or tested. Ignored source
state, credentials, dependencies and untracked files are not copied. A dirty
tracked tree or nonignored untracked files are rejected. The workflow rejects
tracked runtime state, submodules and links escaping the checkout. Empty ordinary
`store`, `groups`, `logs` or `data` directories left by checks are allowed: they
contain no entries and Git does not publish them. A nested entry, regular file,
or symlink at any of these names is rejected. `.env` and `.claudeclaw.json` remain
forbidden even when empty. The helper does not remove such files or directories.
It does not make commits: changes in its workspace must be committed explicitly.
A new committed HEAD or tracked-byte fingerprint invalidates all previous check
receipts. Changed helper code, tool versions or Git configuration require a new
workflow. The helper runs the repository's fixed npm scripts; review those scripts
as code before using it.

The fixed checks are root `npm ci`, runner `npm ci`, Chromium installation using
the locked Playwright CLI, `npm run build`, `npm run typecheck`, `npm test`, each
tracked shell script's syntax, and Gitleaks on the tracked snapshot and
`remote-base..HEAD`. Gitleaks uses its default rules with repository ignore files
and inline allow comments disabled. It is a credential detector, not proof that
all personal information or every possible secret is absent. A public export
still requires its separate privacy and release procedure.

Each actual step has a durable start and a private result tied to workflow
version, helper hash, input HEAD and tracked-byte hash. Each command starts behind
a host-controlled pipe gate: its process group is durably recorded before the
gate opens. A supervisor crash before that record makes the child exit without
executing the command. A supervisor finishes the
current step if the CLI process exits; it does not start subsequent steps. Only
an explicit `resume` continues. A live or uncertain previous process blocks
re-execution. Cancellation is persisted before the supervisor sends TERM and
then KILL to its own command process group. The supervisor waits for termination;
a cancelled workflow cannot resume. Killing the supervisor itself can leave an
orphan command: recovery refuses to run while that process group remains alive.
This is process accounting, not an OS sandbox against code that deliberately
escapes its process group or edits files as the same operating-system user.

Publication requires every check for the current input, a fresh GitHub API proof
that the bound repository is private, and an explicitly bound `feature/`, `fix/`
or `chore/` branch. Default, production and release branches are forbidden. Git
uses the canonical HTTPS URL and a host-owned `pre-push` hook outside the checkout;
inherited hooks and global Git settings are overridden. The hook checks the exact
remote OID advertised by Git against the recorded expected OID. Push is ordinary
non-force, single-ref and exact-SHA. A concurrent remote change stops publication.

A failed or lost push response is not treated as a failed remote action. The
helper reads the exact remote ref: the requested commit confirms completion;
a different unexpected commit blocks any overwrite; a read/authentication error
remains unknown. Explicit retry reads first. Even after the execution-attempt cap,
`publish` can confirm an already-present exact commit without issuing another
push. Cancellation during push preserves an unconfirmed outcome; it does not
claim rollback of an external action.

Limits: two execution attempts per step per input generation; three input
generations; workflow age 24 hours; at most 16 workflows per state root; tracked
files at most 64 MiB each, 256 MiB total and 50,000 entries. Each command has a
fixed deadline (2–30 minutes); each attempt's combined log is capped at 2 MiB.
Logs and JSON receipts are mode 0600, state folders mode 0700. Logs can contain
private build output and must not be published. Dependency caches, Git objects
and build artifacts are not included in the tracked-tree or log size limit;
operator cleanup of completed workflow directories controls their disk usage.
No automatic cleanup removes source files or unfinished work.

Tests use disposable local Git repositories, actual command processes and a real
SIGKILL of the workflow CLI process. GitHub metadata and transport are injected
only inside Python tests. There is no CLI command, environment switch or receipt
import option that declares a check passed without executing its fixed step.
