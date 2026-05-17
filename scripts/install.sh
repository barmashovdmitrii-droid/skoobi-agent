#!/usr/bin/env bash
set -euo pipefail

REPO_DEFAULT="https://github.com/OWNER/skoobi-agent.git"
REF_DEFAULT="main"
APP_NAME="skoobi-agent"
VERSION="1.2.14"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P || pwd)"
CHECKOUT_DIR="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P || true)"

PREFIX="${SKOOBI_PREFIX:-$HOME/.skoobi}"
INSTANCE="default"
REPO="$REPO_DEFAULT"
REPO_SET=0
REF="$REF_DEFAULT"
NO_SERVICE=0
NO_START=0
YES=0
DRY_RUN=0
PRINT_SERVICE=""

prefer_node22_path() {
  local candidate
  for candidate in /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin; do
    if [[ -x "$candidate/node" && -x "$candidate/npm" ]]; then
      PATH="$candidate:$PATH"
      export PATH
      return 0
    fi
  done
}

prefer_node22_path

log() { printf '%s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
Skoobi installer

Usage:
  scripts/install.sh [options]
  curl -fsSL https://github.com/OWNER/skoobi-agent/releases/latest/download/install.sh | bash
  bash <(curl -fsSL https://github.com/OWNER/skoobi-agent/releases/latest/download/install.sh)

Options:
  --prefix <path>        Install prefix (default: ~/.skoobi)
  --instance <name>      Instance name (default: default)
  --repo <url>           Git repository URL
  --ref <branch/tag/sha> Git ref to checkout (default: main)
  --no-service           Do not create launchd/systemd service
  --no-start             Create service but do not start it
  --yes                  Non-interactive defaults
  --dry-run              Print planned actions without changing files
  --version              Show installer version
  --help                 Show this help

Environment for non-interactive setup:
  SKOOBI_TELEGRAM_BOT_TOKEN  Telegram bot token to write to instance .env
  SKOOBI_ASSISTANT_NAME      Assistant name (default: Skoobi)
  SKOOBI_INSTALL_PROVIDER    codex | claude | openai (default: codex)

Security:
  The installer never reads ~/.codex/auth.json, ~/.claude session files,
  browser cookies, or token stores. Secrets are written only to instance .env.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      PREFIX="${2:-}"
      [[ -n "$PREFIX" ]] || die "--prefix requires a path"
      shift 2
      ;;
    --instance)
      INSTANCE="${2:-}"
      [[ -n "$INSTANCE" ]] || die "--instance requires a name"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      [[ -n "$REPO" ]] || die "--repo requires a URL"
      REPO_SET=1
      shift 2
      ;;
    --ref)
      REF="${2:-}"
      [[ -n "$REF" ]] || die "--ref requires a branch, tag, or SHA"
      shift 2
      ;;
    --no-service)
      NO_SERVICE=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --yes|-y)
      YES=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --version|-V)
      printf 'skoobi-installer %s\n' "$VERSION"
      exit 0
      ;;
    --print-service)
      PRINT_SERVICE="${2:-}"
      [[ "$PRINT_SERVICE" == "macos" || "$PRINT_SERVICE" == "linux" ]] || die "--print-service requires macos or linux"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

case "$INSTANCE" in
  *[!A-Za-z0-9_-]*|'') die "Instance name must contain only letters, digits, _ or -" ;;
esac

PREFIX="${PREFIX/#\~/$HOME}"
APP_BASE="$PREFIX/app"
APP_DIR="$APP_BASE/$APP_NAME"
INSTANCE_DIR="$PREFIX/instances/$INSTANCE"
BACKUP_DIR="$PREFIX/backups"
ENV_FILE="$INSTANCE_DIR/.env"
SERVICE_LABEL="com.skoobi.$INSTANCE"
MACOS_PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
LINUX_UNIT="$HOME/.config/systemd/user/skoobi-$INSTANCE.service"
CLI_LINK_DIR="$HOME/.local/bin"
CLI_LINK="$CLI_LINK_DIR/skoobi"
CLI_TARGET="$APP_DIR/bin/skoobi.js"

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %q' "$1"
    shift || true
    for arg in "$@"; do printf ' %q' "$arg"; done
    printf '\n'
  else
    "$@"
  fi
}

write_file() {
  local file="$1"
  local content="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] write %s\n' "$file"
  else
    mkdir -p "$(dirname "$file")"
    printf '%s' "$content" >"$file"
  fi
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

env_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

set_env_key() {
  local key="$1"
  local value="$2"
  local quoted
  quoted="$(env_quote "$value")"
  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ "$key" == *TOKEN* || "$key" == *KEY* || "$key" == *SECRET* ]]; then
      printf '[dry-run] set %s=<redacted> in %s\n' "$key" "$ENV_FILE"
    else
      printf '[dry-run] set %s=%s in %s\n' "$key" "$quoted" "$ENV_FILE"
    fi
    return
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  local tmp
  tmp="$(mktemp "$ENV_FILE.tmp.XXXXXX")"
  if grep -Eq "^[[:space:]]*${key}=" "$ENV_FILE"; then
    awk -v key="$key" -v line="$key=$quoted" '
      BEGIN { done=0 }
      $0 ~ "^[[:space:]]*" key "=" { if (!done) { print line; done=1 }; next }
      { print }
      END { if (!done) print line }
    ' "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"
    printf '\n%s=%s\n' "$key" "$quoted" >>"$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE" || true
}

env_has_key() {
  [[ -f "$ENV_FILE" ]] && grep -Eq "^[[:space:]]*$1=" "$ENV_FILE"
}

read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 1
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); gsub(/^["'\'' ]+|["'\'' ]+$/, ""); print; exit }' "$ENV_FILE"
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "$cmd is required"
  fi
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *) echo "unsupported" ;;
  esac
}

node_bin() {
  command -v node
}

resolve_default_repo_from_checkout() {
  [[ "$REPO_SET" == "0" ]] || return 0
  [[ "$REPO" == "$REPO_DEFAULT" ]] || return 0
  [[ -n "$CHECKOUT_DIR" && -d "$CHECKOUT_DIR/.git" ]] || return 0

  local remote_name remote_url
  for remote_name in skoobi-private origin; do
    remote_url="$(git -C "$CHECKOUT_DIR" remote get-url "$remote_name" 2>/dev/null || true)"
    case "$remote_url" in
      *OWNER/skoobi-agent.git*)
        REPO="$remote_url"
        return 0
        ;;
    esac
  done
}

launchd_plist() {
  local node_path="$1"
  local label_esc app_esc cwd_esc out_esc err_esc home_esc
  label_esc="$(xml_escape "$SERVICE_LABEL")"
  app_esc="$(xml_escape "$APP_DIR/dist/service.js")"
  cwd_esc="$(xml_escape "$INSTANCE_DIR")"
  out_esc="$(xml_escape "$INSTANCE_DIR/logs/service.out.log")"
  err_esc="$(xml_escape "$INSTANCE_DIR/logs/service.err.log")"
  home_esc="$(xml_escape "$HOME")"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label_esc</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_path")</string>
    <string>$app_esc</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$cwd_esc</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$home_esc/.local/bin</string>
    <key>HOME</key>
    <string>$home_esc</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$out_esc</string>
  <key>StandardErrorPath</key>
  <string>$err_esc</string>
</dict>
</plist>
EOF
}

systemd_unit() {
  local node_path="$1"
  cat <<EOF
[Unit]
Description=Skoobi ($INSTANCE)
After=network.target

[Service]
Type=simple
ExecStart="$node_path" "$APP_DIR/dist/service.js"
WorkingDirectory="$INSTANCE_DIR"
Restart=always
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin

[Install]
WantedBy=default.target
EOF
}

if [[ -n "$PRINT_SERVICE" ]]; then
  if [[ "$PRINT_SERVICE" == "macos" ]]; then
    launchd_plist "$(command -v node || echo /usr/bin/node)"
  else
    systemd_unit "$(command -v node || echo /usr/bin/node)"
  fi
  exit 0
fi

check_requirements() {
  if [[ "${SKOOBI_INSTALLER_SKIP_REQUIREMENTS:-}" == "1" ]]; then
    log "Skipping requirement checks (SKOOBI_INSTALLER_SKIP_REQUIREMENTS=1)"
    return 0
  fi
  local os_name
  os_name="$(detect_os)"
  [[ "$os_name" != "unsupported" ]] || die "Only macOS and Linux are supported"
  require_command curl
  require_command git
  require_command npm
  require_command node
  require_command sqlite3
  local major
  major="$(node_major)"
  [[ "$major" -ge 22 ]] || die "Node.js >= 22 is required; found $(node --version 2>/dev/null || echo unknown)"
  if [[ "$NO_SERVICE" == "0" ]]; then
    if [[ "$os_name" == "macos" ]]; then
      require_command launchctl
    else
      require_command systemctl
    fi
  fi
}

install_app() {
  run mkdir -p "$APP_BASE" "$BACKUP_DIR"
  if [[ -d "$APP_DIR/.git" ]]; then
    log "Updating app in $APP_DIR"
    run git -C "$APP_DIR" fetch --tags --prune origin
  else
    log "Cloning $REPO into $APP_DIR"
    run git clone "$REPO" "$APP_DIR"
  fi
  run git -C "$APP_DIR" checkout "$REF"
  run npm --prefix "$APP_DIR" ci
  run npm --prefix "$APP_DIR" run build
  if [[ -f "$APP_DIR/agent/runner/package.json" || "$DRY_RUN" == "1" ]]; then
    run npm --prefix "$APP_DIR/agent/runner" ci
    run npm --prefix "$APP_DIR/agent/runner" run build
  fi
}

prepare_instance() {
  run mkdir -p "$INSTANCE_DIR/store" "$INSTANCE_DIR/groups" "$INSTANCE_DIR/logs" "$INSTANCE_DIR/data" "$BACKUP_DIR"
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      log "[dry-run] create $ENV_FILE from .env.example"
    elif [[ -f "$APP_DIR/.env.example" ]]; then
      cp "$APP_DIR/.env.example" "$ENV_FILE"
      chmod 600 "$ENV_FILE" || true
    else
      printf 'RUNTIME=sandbox\nASSISTANT_NAME=Skoobi\nSKOOBI_TELEGRAM_GUEST_LIVE_ENABLED=false\n' >"$ENV_FILE"
      chmod 600 "$ENV_FILE" || true
    fi
  else
    local backup="$BACKUP_DIR/${INSTANCE}.env.$(date +%Y%m%d%H%M%S).bak"
    log "Existing .env found; backing up before edits: $backup"
    run cp "$ENV_FILE" "$backup"
  fi
}

configure_env() {
  local assistant="${SKOOBI_ASSISTANT_NAME:-}"
  if [[ -z "$assistant" && "$YES" == "0" ]]; then
    read -r -p "Assistant name [Skoobi]: " assistant || true
  fi
  assistant="${assistant:-Skoobi}"
  set_env_key ASSISTANT_NAME "$assistant"
  set_env_key RUNTIME "sandbox"
  set_env_key SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED "false"
  set_env_key SKOOBI_LIVE_CANARY_ENABLED "false"
  set_env_key SKOOBI_GLOBAL_CREDIT_COEFFICIENT "100000"
  set_env_key SKOOBI_DEFAULT_WEEKLY_LIMIT_CREDITS "700000"

  local token="${SKOOBI_TELEGRAM_BOT_TOKEN:-}"
  if [[ -z "$token" && "$YES" == "0" ]]; then
    local current_token=""
    current_token="$(read_env_value TELEGRAM_BOT_TOKEN || true)"
    if [[ -z "$current_token" ]]; then
      read -r -s -p "Telegram bot token (input hidden, leave blank to skip): " token || true
      printf '\n'
    fi
  fi
  if [[ -n "$token" ]]; then
    set_env_key TELEGRAM_BOT_TOKEN "$token"
  elif ! env_has_key TELEGRAM_BOT_TOKEN; then
    log "Telegram bot token not configured yet. Edit $ENV_FILE before starting Telegram."
  fi

  local provider="${SKOOBI_INSTALL_PROVIDER:-}"
  if [[ -z "$provider" && "$YES" == "0" ]]; then
    log "Choose provider:"
    log "  1) Codex subscription CLI primary + Claude SDK fallback"
    log "  2) Claude SDK only"
    log "  3) OpenAI-compatible API"
    read -r -p "Provider [1]: " provider || true
    case "${provider:-1}" in
      1) provider="codex" ;;
      2) provider="claude" ;;
      3) provider="openai" ;;
    esac
  fi
  provider="${provider:-codex}"
  case "$provider" in
    codex)
      set_env_key SKOOBI_MODEL_GATEWAY_TYPE "codex_subscription_cli"
      set_env_key SKOOBI_CODEX_SUBSCRIPTION_ENABLED "true"
      set_env_key SKOOBI_CODEX_MODEL "gpt-5.5"
      set_env_key SKOOBI_CODEX_FALLBACK_MODEL "gpt-5.4"
      set_env_key SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE "false"
      set_env_key SKOOBI_CODEX_CREDITS_PER_REQUEST "1000"
      if command -v codex >/dev/null 2>&1; then
        log "Codex CLI: $(codex --version 2>/dev/null | head -n 1 || true)"
        if codex login status >/dev/null 2>&1; then
          log "Codex login: active"
        else
          log "Codex login: not active. Run: codex login"
        fi
      else
        log "Codex CLI not found. Install Codex and run: codex login"
      fi
      if command -v claude >/dev/null 2>&1; then
        log "Claude CLI fallback: $(claude --version 2>/dev/null | head -n 1 || true)"
      else
        log "Claude CLI fallback not found. Install/login Claude SDK if you want fallback."
      fi
      ;;
    claude)
      set_env_key SKOOBI_MODEL_GATEWAY_TYPE "disabled"
      set_env_key SKOOBI_CODEX_SUBSCRIPTION_ENABLED "false"
      if command -v claude >/dev/null 2>&1; then
        log "Claude CLI: $(claude --version 2>/dev/null | head -n 1 || true)"
      else
        log "Claude CLI not found. Install/login Claude before starting."
      fi
      ;;
    openai)
      set_env_key SKOOBI_MODEL_GATEWAY_TYPE "openai_compatible"
      set_env_key SKOOBI_MODEL_GATEWAY_BASE_URL "${SKOOBI_MODEL_GATEWAY_BASE_URL:-https://api.openai.com/v1}"
      if [[ -n "${SKOOBI_MODEL_GATEWAY_KEY:-}" ]]; then
        set_env_key SKOOBI_MODEL_GATEWAY_KEY "$SKOOBI_MODEL_GATEWAY_KEY"
      fi
      log "OpenAI-compatible provider selected. Put the API key in $ENV_FILE; it will not be printed."
      ;;
    *) die "Unknown provider: $provider" ;;
  esac
}

confirm_cli_replace() {
  [[ "$YES" == "1" ]] && return 0
  [[ "$DRY_RUN" == "1" ]] && return 0
  local answer=""
  read -r -p "$CLI_LINK already exists. Back it up and replace with Skoobi CLI symlink? [y/N]: " answer || true
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_cli_link_dir() {
  [[ -d "$CLI_LINK_DIR" ]] && return 0
  if [[ "$YES" == "1" || "$DRY_RUN" == "1" ]]; then
    run mkdir -p "$CLI_LINK_DIR"
    return 0
  fi
  local answer=""
  read -r -p "Create $CLI_LINK_DIR and install the skoobi CLI symlink? [y/N]: " answer || true
  case "$answer" in
    y|Y|yes|YES)
      run mkdir -p "$CLI_LINK_DIR"
      return 0
      ;;
    *)
      log "Skipping optional CLI symlink. You can run: $CLI_TARGET"
      return 1
      ;;
  esac
}

install_cli_symlink() {
  ensure_cli_link_dir || return 0

  if [[ -L "$CLI_LINK" ]]; then
    local current_target
    current_target="$(readlink "$CLI_LINK" || true)"
    if [[ "$current_target" == "$CLI_TARGET" ]]; then
      log "CLI symlink already installed: $CLI_LINK -> $CLI_TARGET"
      return 0
    fi
  fi

  if [[ -e "$CLI_LINK" || -L "$CLI_LINK" ]]; then
    confirm_cli_replace || {
      log "Skipping optional CLI symlink; existing path preserved: $CLI_LINK"
      return 0
    }
    local backup="$CLI_LINK.backup.$(date +%Y%m%d%H%M%S)"
    log "Backing up existing CLI path: $CLI_LINK -> $backup"
    run mv "$CLI_LINK" "$backup"
  fi

  run ln -s "$CLI_TARGET" "$CLI_LINK"
  log "CLI symlink: $CLI_LINK -> $CLI_TARGET"
}

install_service() {
  [[ "$NO_SERVICE" == "0" ]] || return 0
  local os_name node_path
  os_name="$(detect_os)"
  node_path="$(node_bin)"
  if [[ "$os_name" == "macos" ]]; then
    write_file "$MACOS_PLIST" "$(launchd_plist "$node_path")"
    if [[ "$NO_START" == "1" ]]; then
      log "Service plist written. Start with:"
      log "  launchctl bootstrap gui/\$(id -u) $MACOS_PLIST"
      log "  launchctl kickstart -k gui/\$(id -u)/$SERVICE_LABEL"
    elif [[ "$DRY_RUN" == "1" ]]; then
      log "[dry-run] launchctl bootstrap/kickstart $SERVICE_LABEL"
    else
      launchctl bootout "gui/$(id -u)" "$MACOS_PLIST" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$MACOS_PLIST"
      launchctl enable "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || true
      launchctl kickstart -k "gui/$(id -u)/$SERVICE_LABEL"
    fi
  else
    write_file "$LINUX_UNIT" "$(systemd_unit "$node_path")"
    if [[ "$NO_START" == "1" ]]; then
      log "Systemd unit written. Start with:"
      log "  systemctl --user daemon-reload"
      log "  systemctl --user enable --now skoobi-$INSTANCE"
    elif [[ "$DRY_RUN" == "1" ]]; then
      log "[dry-run] systemctl --user daemon-reload && enable --now skoobi-$INSTANCE"
    else
      systemctl --user daemon-reload
      systemctl --user enable --now "skoobi-$INSTANCE"
    fi
  fi
}

health_check() {
  if [[ "$DRY_RUN" == "1" || "$NO_START" == "1" || "$NO_SERVICE" == "1" ]]; then
    return 0
  fi
  log "Health:"
  if [[ -f "$INSTANCE_DIR/store/messages' + '.db" ]]; then
    log "  DB exists: $INSTANCE_DIR/store/messages' + '.db"
  else
    log "  DB not created yet. It should appear after first service startup."
  fi
  if [[ "$(detect_os)" == "macos" ]]; then
    if launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
      log "  service running/loaded: $SERVICE_LABEL"
    else
      log "  service not loaded: $SERVICE_LABEL"
    fi
  else
    systemctl --user is-active "skoobi-$INSTANCE" >/dev/null 2>&1 && log "  service active: skoobi-$INSTANCE" || log "  service not active: skoobi-$INSTANCE"
  fi
}

main() {
  resolve_default_repo_from_checkout
  log "Skoobi installer"
  log "prefix: $PREFIX"
  log "app: $APP_DIR"
  log "instance: $INSTANCE_DIR"
  log "repo/ref: $REPO @ $REF"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "mode: dry-run"
  fi
  check_requirements
  install_app
  prepare_instance
  configure_env
  install_cli_symlink
  install_service
  health_check
  cat <<EOF

Skoobi install complete.

App:      $APP_DIR
Instance: $INSTANCE_DIR
Config:   $ENV_FILE
Service:  $SERVICE_LABEL
CLI:      $CLI_LINK

Edit config:
  \$EDITOR "$ENV_FILE"

Start/stop/restart:
  macOS: launchctl kickstart -k "gui/\$(id -u)/$SERVICE_LABEL"
  Linux: systemctl --user restart "skoobi-$INSTANCE"

Logs:
  macOS: tail -f "$INSTANCE_DIR/logs/service.out.log" "$INSTANCE_DIR/logs/service.err.log"
  Linux: journalctl --user -u "skoobi-$INSTANCE" -f

Uninstall:
  "$APP_DIR/scripts/uninstall.sh" --prefix "$PREFIX" --instance "$INSTANCE"

Telegram setup:
  Put TELEGRAM_BOT_TOKEN in $ENV_FILE if it is not set yet.
  New installs keep SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED=false by default.
EOF
}

main "$@"
