# Install Skoobi Agent

Skoobi Agent installs into an app/instance layout:

```text
~/.skoobi/
  app/skoobi-agent/             # code checkout
  instances/default/            # user data and runtime cwd
    .env
    store/
    groups/
    logs/
    data/
  backups/
```

The service runs:

```bash
node ~/.skoobi/app/skoobi-agent/dist/service.js
```

with `WorkingDirectory` set to:

```bash
~/.skoobi/instances/default
```

That is important because Skoobi uses cwd as its state root.

## Public Release Install

Review `install.sh` before piping it to `bash`.

```bash
curl -fsSL https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/latest/download/install.sh | bash
```

or:

```bash
bash <(curl -fsSL https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/latest/download/install.sh)
```

Useful flags:

```bash
bash <(curl -fsSL https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/latest/download/install.sh) \
  --prefix "$HOME/.skoobi" \
  --instance default
```

The release installer downloads source, checks out the requested ref, installs dependencies, builds the app, and creates an isolated instance directory.

## Private Fork Install

If you install from a private fork, authenticated raw GitHub URLs may return 404. Authenticate GitHub access first, then fetch the installer through `gh api` and pass your fork's SSH repo URL:

```bash
gh api repos/YOUR-OWNER/skoobi-agent/contents/scripts/install.sh \
  --jq '.content' \
  | base64 --decode \
  | bash -s -- \
      --repo git@github.com:YOUR-OWNER/skoobi-agent.git
```

`gh api` downloads the private `scripts/install.sh` through your authenticated GitHub CLI session. `--repo git@github.com:...` tells the installer which repository to clone.

Alternatively, clone the fork and run the local installer:

```bash
git clone git@github.com:YOUR-OWNER/skoobi-agent.git
cd skoobi-agent
scripts/install.sh
```

## Requirements

- Node.js 22+
- npm
- git
- sqlite3
- curl
- macOS launchctl or Linux systemd user service
- Telegram bot token
- Optional: Codex CLI login for `codex_subscription_cli`
- Optional: Claude CLI login for Claude SDK fallback

The installer never reads:

- `~/.codex/auth.json`
- `~/.claude` auth/session files
- browser cookies
- localStorage/sessionStorage
- OAuth/session tokens

## Provider Setup

New installs default to:

```bash
SKOOBI_MODEL_GATEWAY_TYPE=codex_subscription_cli
SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true
SKOOBI_CODEX_MODEL=gpt-5.5
SKOOBI_CODEX_FALLBACK_MODEL=gpt-5.4
SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE=false
SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED=false
SKOOBI_LIVE_CANARY_ENABLED=false
```

`SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED=false` is intentional for new installs. Set up Telegram and run a canary before enabling broader live behavior.

## Telegram Setup

Edit the instance `.env`:

```bash
$EDITOR ~/.skoobi/instances/default/.env
```

Set `TELEGRAM_BOT_TOKEN` locally in the instance `.env` to the token from BotFather.

Do not commit `.env`.

## Service Management

macOS:

```bash
launchctl print gui/$(id -u)/com.skoobi.default
launchctl kickstart -k gui/$(id -u)/com.skoobi.default
launchctl kill TERM gui/$(id -u)/com.skoobi.default
tail -f ~/.skoobi/instances/default/logs/service.out.log ~/.skoobi/instances/default/logs/service.err.log
```

Linux:

```bash
systemctl --user status skoobi-default
systemctl --user restart skoobi-default
journalctl --user -u skoobi-default -f
```

The installer also offers an optional CLI symlink:

```text
~/.local/bin/skoobi -> ~/.skoobi/app/skoobi-agent/bin/skoobi.js
```

It never overwrites an existing `~/.local/bin/skoobi` without confirmation or a backup.

If the symlink is installed and `~/.local/bin` is on your `PATH`, use:

```bash
skoobi status
skoobi doctor
skoobi logs
skoobi paths
```

The direct CLI wrapper path always works:

```bash
~/.skoobi/app/skoobi-agent/bin/skoobi.js status
~/.skoobi/app/skoobi-agent/bin/skoobi.js doctor
~/.skoobi/app/skoobi-agent/bin/skoobi.js logs
~/.skoobi/app/skoobi-agent/bin/skoobi.js paths
```

## Update

```bash
~/.skoobi/app/skoobi-agent/scripts/update.sh
```

Update changes app code only. It does not touch:

- instance `.env`
- `groups/`
- `store/`
- `logs/`
- `data/`

## Uninstall

Default uninstall removes the service and app code, but keeps instance data:

```bash
~/.skoobi/app/skoobi-agent/scripts/uninstall.sh
```

To delete data, use `--purge` and type the exact confirmation phrase. Do this only after backup.

## Troubleshooting

Check paths:

```bash
~/.skoobi/app/skoobi-agent/bin/skoobi.js paths
```

Check requirements:

```bash
~/.skoobi/app/skoobi-agent/bin/skoobi.js doctor
```

Check Codex:

```bash
codex --version
codex login status
```

If Codex is not logged in:

```bash
codex login
```

Check Claude fallback:

```bash
claude --version
```

## Future Installers

Planned, not published yet:

```bash
npm exec --yes create-skoobi@latest
brew install barmashovdmitrii-droid/skoobi/skoobi
```

## Security Notes

- Secrets go only into the instance `.env`.
- The service file does not embed Telegram/OpenAI/Codex/Claude secrets.
- `groups/`, `store/`, `logs/`, and `.env` are instance data, not app source.
- The installer does not read Codex/Claude auth files or browser tokens.
- Global Telegram guest live is false by default for new installs.
