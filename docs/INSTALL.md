# Installation

The managed installation is the recommended path for a persistent personal
instance. It keeps application code and private runtime state in separate
directories and installs a user service.

## Requirements

- macOS, or Ubuntu/Debian with a systemd user session
- Node.js 22 or newer and npm
- Git, curl, `sqlite3`, and ripgrep (`rg`)
- native build tools
- Linux only: Bubblewrap (`bwrap`) and `socat`
- an authenticated local Codex CLI
- a Telegram bot token

## Five-minute managed setup

The interactive work takes about five minutes. The initial npm installation and
build may take longer.

### 1. Install prerequisites

#### macOS

Install [Homebrew](https://brew.sh/) first if it is not already available, then
run:

```bash
xcode-select -p >/dev/null 2>&1 || xcode-select --install
brew install node@22 git sqlite ripgrep

mkdir -p "$HOME/.local/bin"
export PATH="$(brew --prefix node@22)/bin:$HOME/.local/bin:$PATH"
```

If macOS opens the Command Line Tools installer, wait for it to finish before
continuing.

#### Ubuntu or Debian

These commands target an Ubuntu or Debian installation with a working systemd
user session:

```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates curl git sqlite3 ripgrep bubblewrap socat \
  build-essential python3

(
  set -eu
  NODE_SOURCE_DIR="$(mktemp -d)"
  trap 'rm -rf -- "$NODE_SOURCE_DIR"' EXIT
  chmod 700 "$NODE_SOURCE_DIR"
  curl -fsSL https://deb.nodesource.com/setup_22.x \
    -o "$NODE_SOURCE_DIR/setup.sh"
  sudo -E bash "$NODE_SOURCE_DIR/setup.sh"
  sudo apt-get install -y nodejs
)

mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
```

Verify the runtime before continuing:

```bash
node --version
npm --version
rg --version
sqlite3 --version
```

`node --version` must report version 22 or newer.

### 2. Install and authenticate Codex CLI

Install Codex under the same user account that will run Skoobi:

```bash
npm install --global --prefix "$HOME/.local" @openai/codex
codex login
codex login status
```

`codex login` opens an official browser sign-in flow. The managed installer
requires a successful `codex login status` for its default provider.

### 3. Create the Telegram bot

1. Open [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose the display name and unique bot username.
4. Copy the generated token and store it securely.

The token controls the bot. Never commit it, paste it into an issue, or put it
directly in a shell command.

### 4. Verify and run the pinned installer

Download both assets from the tagged release:

```bash
VERSION=v2.0.0-rc.2
curl -fLO "https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/download/$VERSION/install.sh"
curl -fLO "https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/download/$VERSION/install.sh.sha256"
```

Verify the checksum on macOS:

```bash
shasum -a 256 -c install.sh.sha256
```

Or verify it on Ubuntu/Debian:

```bash
sha256sum -c install.sh.sha256
```

Only after verification succeeds, run:

```bash
bash install.sh
```

The release workflow embeds the exact tagged commit into `install.sh`. The
installer aborts if the remote tag no longer resolves to that commit, even when
the downloaded script's checksum is valid.

The installer asks for:

- the assistant name, with `Skoobi` as the default;
- the Telegram bot token, using hidden terminal input.

It also checks the required tools and Codex login before activating the new
release.

### 5. Initialize the first owner

The Telegram token identifies the bot, not its human owner. Skoobi therefore
does not trust the first account that happens to message a new bot.

Open a private chat with the bot and send:

```text
/chatid
```

The bot returns a value such as:

```text
Chat ID: tg:123456789
```

Copy the complete `tg:` value and run:

```bash
skoobi owner init tg:123456789
skoobi restart
```

Use the exact private ID returned by `/chatid`. Do not substitute a Telegram
username or a group ID. `skoobi owner init` records one owner allowlist entry
and one main Telegram registration. It refuses to overwrite a different or
ambiguous existing owner.

### 6. Verify end to end

Send:

```text
/ping
```

The bot should report that the assistant is online. This verifies Telegram
connectivity. Next, send a normal message to verify an actual Codex-backed
assistant response.

Run the local checks:

```bash
skoobi doctor
skoobi status
```

A ready installation ends the doctor output with:

```text
overall: ready
```

If it reports `overall: needs attention`, fix the named problem before enabling
optional integrations.

## Installed paths and service

With the default prefix and instance name, the installer creates:

| Purpose                | Path or service                     |
| ---------------------- | ----------------------------------- |
| Application checkout   | `~/.skoobi/app/skoobi-agent/`       |
| Private instance state | `~/.skoobi/instances/default/`      |
| Instance configuration | `~/.skoobi/instances/default/.env`  |
| Logs                   | `~/.skoobi/instances/default/logs/` |
| CLI link               | `~/.local/bin/skoobi`               |
| macOS service          | `com.skoobi.default`                |
| Linux user service     | `skoobi-default.service`            |

The installer creates `~/.local/bin` when needed, but it does not edit
`.zshrc`, `.bashrc`, `.profile`, or any other shell startup file. The current
Quick Start exports the path for the active terminal only. Add it to your
preferred shell profile yourself if you want it to persist.

A normal installer rerun preserves the existing instance `.env`. Use
`--reconfigure` only when you intentionally want the installer to update that
configuration.

## Common operations

Check readiness, service state, and recent logs:

```bash
skoobi doctor
skoobi status
skoobi logs
```

Restart the default instance:

```bash
skoobi restart
```

Update a managed installation:

```bash
skoobi update
```

The updater refuses a dirty application checkout. It builds in a private
staging directory and does not replace the active release unless the build
succeeds.

Use `--force --yes` only when you explicitly want an owner-only backup of
tracked, untracked, ignored, and symlinked application changes followed by
replacement of the active release. Git submodules and FIFO, socket, or device
files are refused because a normal owner backup cannot safely represent them.

Uninstall service and application files while preserving instance data:

```bash
skoobi uninstall
```

To remove instance data as well:

```bash
skoobi uninstall --purge
```

The purge path requires an exact interactive confirmation phrase. Back up any
conversations, memory, or databases you want to keep first.

## Existing and legacy managed installations

An installation created by an older public release may retain a different local
application directory name. The installer never guesses or silently selects
one. Preserve a verified legacy checkout explicitly by passing its single
directory basename:

```bash
bash install.sh --migrate-legacy <directory-name>
```

The named directory must be a direct child of the managed app directory, a
clean real Git checkout without ignored files or Git submodules, and use the
canonical public HTTPS origin. Its code is not executed by the installer.

If a verified canonical public installation predates the managed marker, adopt
it once with:

```bash
bash install.sh --adopt-managed
```

Neither migration option accepts an unrelated repository.

## Source installation

Source mode is intended for development. Install and authenticate the same
prerequisites described above, then build:

```bash
git clone https://github.com/barmashovdmitrii-droid/skoobi-agent.git
cd skoobi-agent
npm ci
npm ci --prefix agent/runner
npm run build
```

Create private state outside the checkout:

```bash
APP_DIR="$PWD"
DEV_PREFIX="$HOME/.skoobi-dev"
STATE_ROOT="$DEV_PREFIX/instances/default"
umask 077

install -d -m 700 \
  "$DEV_PREFIX" \
  "$DEV_PREFIX/instances" \
  "$STATE_ROOT" \
  "$STATE_ROOT/groups" \
  "$STATE_ROOT/store" \
  "$STATE_ROOT/logs" \
  "$STATE_ROOT/data"
install -m 600 .env.example "$STATE_ROOT/.env"
```

Edit `$STATE_ROOT/.env` and set `TELEGRAM_BOT_TOKEN`. Keep the Codex defaults
unless you are deliberately configuring another provider. Start the service in
the foreground:

```bash
(cd "$STATE_ROOT" && node "$APP_DIR/dist/service.js")
```

In a second terminal, send `/chatid` to the bot and initialize the owner with
the exact returned value:

```bash
APP_DIR="/absolute/path/to/skoobi-agent"
node "$APP_DIR/bin/skoobi.js" owner init tg:123456789 \
  --prefix "$HOME/.skoobi-dev"
```

Stop and restart the foreground service after owner initialization. Source mode
does not create a persistent user service; use the managed installer for that.

Never place an instance inside a directory containing unrelated credentials or
private project data.

## Troubleshooting

### `skoobi: command not found`

The installer does not edit shell profiles. Enable the CLI in the current
terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then retry `skoobi doctor`. Add the same export to your chosen shell profile if
you want it in future terminals.

### The installer reports a missing Linux sandbox dependency

Install the required runtime tools:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap socat ripgrep
```

### Codex is missing or not authenticated

```bash
export PATH="$HOME/.local/bin:$PATH"
codex --version
codex login
codex login status
```

Rerun the installer after authentication.

### The bot does not answer `/chatid` or `/ping`

Check the service and sanitized logs:

```bash
skoobi status
skoobi logs
```

If the token was skipped, rerun the same verified installer explicitly:

```bash
bash install.sh --reconfigure
skoobi restart
```

The token prompt is hidden. If a nonempty but incorrect token is already stored,
replace `TELEGRAM_BOT_TOKEN` in
`~/.skoobi/instances/default/.env`, keep the file private, and run
`skoobi restart`. Do not print the token while troubleshooting.

### Owner initialization says the database is not initialized

The service must start once before the owner can be registered:

```bash
skoobi restart
skoobi status
```

Send `/chatid` again and retry `skoobi owner init` with the exact private
`tg:` value.

### `/ping` works but normal messages fail

Telegram is connected, but the model path is not healthy. Run:

```bash
codex login status
skoobi doctor
skoobi logs
```

Do not enable guest access or optional integrations to work around a failed
owner route.

### Linux user service is unavailable

The managed Linux service requires a functioning systemd user session. On a
different init system, install with `--no-service` and start the service
manually from the instance directory:

```bash
(cd "$HOME/.skoobi/instances/default" && \
  node "$HOME/.skoobi/app/skoobi-agent/dist/service.js")
```

This foreground process must remain running.
