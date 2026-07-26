# Skoobi Agent

Skoobi Agent is a self-hosted, Telegram-first personal assistant for macOS and
Linux. It keeps conversations and runtime state on your computer, uses an
authenticated local Codex CLI by default, and runs owner tools inside an
isolated sandbox.

The `2.0.0` line is a major architecture update and is currently a release
candidate. Review the release notes before upgrading an older installation.

## Quick start

The interactive setup takes about five minutes. The first dependency install
and source build can take longer.

### 1. Install system requirements

On macOS with [Homebrew](https://brew.sh/):

```bash
xcode-select -p >/dev/null 2>&1 || xcode-select --install
brew install node@22 git sqlite ripgrep

mkdir -p "$HOME/.local/bin"
export PATH="$(brew --prefix node@22)/bin:$HOME/.local/bin:$PATH"
```

Wait for the Command Line Tools installer to finish before continuing if
`xcode-select --install` opens a system dialog.

On Ubuntu or Debian with a systemd user session:

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

Confirm that Node.js 22 or newer is active:

```bash
node --version
```

### 2. Install and authenticate Codex CLI

```bash
npm install --global --prefix "$HOME/.local" @openai/codex
codex login
codex login status
```

Complete the browser sign-in opened by `codex login`. Skoobi's managed service
uses the absolute Codex path found during installation.

### 3. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot` and follow the prompts.
3. Copy the bot token. Treat it like a password and never commit or post it.

### 4. Download and verify the release installer

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

Run the verified installer:

```bash
bash install.sh
```

The installer asks for an assistant name and then for the Telegram token. Token
input is hidden. Do not put the token directly in a shell command or pipe a
moving branch into a shell.

### 5. Initialize your private owner chat

Open a private chat with your new bot and send:

```text
/chatid
```

Copy the complete private ID returned by the bot, including the `tg:` prefix,
then run:

```bash
skoobi owner init tg:123456789
skoobi restart
```

Replace `tg:123456789` with the exact value from `/chatid`. Do not use a
username or a group-chat ID. The owner command is fail-closed: it will not
replace a different or ambiguous existing owner.

### 6. Verify the installation

Send `/ping` to the bot. It should reply that the assistant is online. Then
send a normal message to confirm that the Codex response path also works.

Finally, run:

```bash
skoobi doctor
skoobi status
```

`skoobi doctor` exits unsuccessfully and prints `overall: needs attention` when
a required executable, Telegram configuration, owner registration, Codex
login, or owner Codex route is not ready.

## What the installer changes

The managed installer:

- verifies and builds the exact commit embedded in the release asset;
- installs code under `~/.skoobi/app/skoobi-agent/`;
- keeps instance state under `~/.skoobi/instances/default/`;
- creates a user launchd service on macOS or user systemd service on Linux;
- creates `~/.local/bin/skoobi`;
- preserves an existing instance `.env` on a normal rerun.

The installer does not edit `.zshrc`, `.bashrc`, `.profile`, or another shell
startup file. If a new terminal cannot find `skoobi`, add
`$HOME/.local/bin` to that shell's `PATH` yourself.

## Common commands

```bash
skoobi status
skoobi doctor
skoobi logs
skoobi restart
skoobi update
```

An upgrade from `2.0.0-rc.1` needs one explicit, checksum-verified
`install.sh --reconfigure` run because the updater intentionally preserves
`.env`. Follow the rc.1 migration steps in
[docs/INSTALL.md](docs/INSTALL.md#upgrading-from-200-rc1); do not enable the
Codex profile blindly on an installation that uses another provider.

See [docs/INSTALL.md](docs/INSTALL.md) for source installation, lifecycle
details, legacy migration, and troubleshooting.

## Build from source

```bash
git clone https://github.com/barmashovdmitrii-droid/skoobi-agent.git
cd skoobi-agent
npm ci
npm ci --prefix agent/runner
npm run build
```

Keep development state outside the checkout. The complete source-mode workflow
is documented in [docs/INSTALL.md](docs/INSTALL.md). Use the managed installer
for a long-running personal instance.

## Development checks

```bash
npm ci
npm ci --prefix agent/runner
npm test
npm run typecheck
npm run build
```

The root build also compiles workspace packages, applications, and the agent
runner.

## Security boundaries

- Display names and usernames are not identity.
- Guest tenants must not read owner or other-tenant memory.
- Runtime state stays outside the source tree and is denied to guest tools.
- Credentials must come from the local environment or protected files.
- The model is not a security boundary; host policy decides tool authority.
- Owner-only actions remain fail-closed and require stable owner identity.
- The optional Desktop bridge accepts only explicitly authorized worktrees.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.

## Optional components

- WhatsApp channel
- local speech-to-text and text-to-speech
- Google Workspace broker
- local dashboard
- Codex Desktop bridge
- webhook triggers
- billing and payment modules

Optional components are disabled until explicitly configured. The payments
package exposes provider-neutral extension ports only: this repository ships
neither a network payment adapter nor a paid catalog, and the Telegram sales
flow remains disabled until a host application deliberately supplies and wires
both.

## Repository hygiene

Never commit `.env`, credentials, chat history, `groups/`, `store/`, `data/`,
logs, local models, Desktop task state, or authentication/session files. Use
the placeholders in `.env.example`.

## Documentation

- [Install](docs/INSTALL.md)
- [Memory and privacy](docs/MEMORY.md)
- [Release process](docs/RELEASE.md)
- [Roadmap](docs/ROADMAP.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Attribution

Skoobi Agent grew from ClaudeClaw and NanoClaw ideas. Upstream copyright and
license notices are retained in [LICENSE](LICENSE).
