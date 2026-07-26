# Installation

## Source installation

Requirements:

- Node.js 22 or newer
- npm
- git
- the `sqlite3` command-line tool
- macOS or Linux

## Managed installation

Install from a tagged GitHub release, verify the checksum, and run the pinned
installer:

```bash
VERSION=v2.0.0-rc.1
curl -fLO "https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/download/$VERSION/install.sh"
curl -fLO "https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/download/$VERSION/install.sh.sha256"
shasum -a 256 -c install.sh.sha256
bash install.sh
```

On Linux, use `sha256sum -c install.sh.sha256` if `shasum` is unavailable.
The release workflow embeds the exact tagged commit into `install.sh`. The
installer aborts if the remote tag no longer resolves to that commit, even when
the downloaded script's checksum is valid.
The installer places code under `~/.skoobi/app/` and instance state under
`~/.skoobi/instances/default/`.

An installation created by an older public release may retain a different local
app directory name. It is never guessed or selected silently. Preserve a
verified legacy checkout explicitly by providing its single directory basename:

```bash
bash install.sh --migrate-legacy <directory-name>
```

The named legacy directory must be a direct child of the managed app directory,
must be a clean real Git checkout with no ignored files or Git submodules, and
must use the current canonical public origin. Its code is never executed by the
installer. If a verified canonical public installation predates the managed
marker, adopt it once with `bash install.sh --adopt-managed`. Neither option
accepts an unrelated repository. A normal rerun preserves the existing
instance `.env`; use `--reconfigure` only when you intentionally want the
installer to update that configuration.

Update a managed installation:

```bash
skoobi update
```

The updater refuses a dirty app checkout. Preserve local source edits first.
Use `--force --yes` only when you explicitly want an owner-only backup of
tracked, untracked, ignored, and symlinked app-code changes followed by
replacement of the active release. The updater builds in a private staging
directory and does not modify the active release unless the build succeeds.
Git submodules and FIFO/socket/device files are refused rather than silently
discarded because they cannot be represented by the normal owner backup.

Uninstall code and service files while preserving instance data:

```bash
skoobi uninstall
```

`skoobi uninstall --purge` additionally removes instance data and requires the
exact interactive confirmation phrase. Back up anything you need first.
Default uninstall refuses an app containing owner files it cannot safely
remove. `skoobi uninstall --force --yes` first backs up changes in a verified
managed app; an unverified app is moved intact to quarantine instead of being
deleted.

## Source installation

```bash
git clone https://github.com/barmashovdmitrii-droid/skoobi-agent.git
cd skoobi-agent
npm ci
npm ci --prefix agent/runner
npm run build
```

Keep runtime state outside the checkout:

```bash
APP_DIR="$PWD"
STATE_ROOT="$HOME/.skoobi/dev/default"
mkdir -p "$STATE_ROOT"/{groups,store,logs,data}
cp .env.example "$STATE_ROOT/.env"
# Review "$STATE_ROOT/.env", then:
(cd "$STATE_ROOT" && node "$APP_DIR/dist/service.js")
```

Do not install an instance inside a directory containing unrelated credentials
or private project data. Code and runtime state should use separate paths.

## Updating

Back up runtime state and read the release notes before updating. Never replace
a live instance with an unreviewed branch or pre-release build.

## Uninstalling

Review the uninstall command before running it. Preserve any conversations,
memory, or databases you intend to keep.
