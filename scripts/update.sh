#!/usr/bin/env bash
set -euo pipefail

PREFIX="${SKOOBI_PREFIX:-$HOME/.skoobi}"
INSTANCE="default"
REF="${SKOOBI_UPDATE_REF:-main}"
NO_START=0
YES=0
DRY_RUN=0
APP_NAME="skoobi-agent"

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
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Skoobi updater

Usage:
  scripts/update.sh [options]

Options:
  --prefix <path>        Install prefix (default: ~/.skoobi)
  --instance <name>      Instance name (default: default)
  --ref <branch/tag/sha> Git ref to checkout (default: main)
  --no-start             Do not restart service after build
  --yes                  Non-interactive defaults
  --dry-run              Print planned actions without changing files
  --help                 Show this help

Update changes only the app checkout. It does not touch instance .env,
groups, store, logs, or data.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; [[ -n "$PREFIX" ]] || die "--prefix requires a path"; shift 2 ;;
    --instance) INSTANCE="${2:-}"; [[ -n "$INSTANCE" ]] || die "--instance requires a name"; shift 2 ;;
    --ref) REF="${2:-}"; [[ -n "$REF" ]] || die "--ref requires a ref"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

case "$INSTANCE" in
  *[!A-Za-z0-9_-]*|'') die "Instance name must contain only letters, digits, _ or -" ;;
esac

PREFIX="${PREFIX/#\~/$HOME}"
APP_DIR="$PREFIX/app/$APP_NAME"
INSTANCE_DIR="$PREFIX/instances/$INSTANCE"
BACKUP_DIR="$PREFIX/backups"
SERVICE_LABEL="com.skoobi.$INSTANCE"
LINUX_UNIT="skoobi-$INSTANCE"

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

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *) echo "unsupported" ;;
  esac
}

restart_service() {
  [[ "$NO_START" == "0" ]] || return 0
  case "$(detect_os)" in
    macos)
      if [[ "$DRY_RUN" == "1" ]]; then
        log "[dry-run] launchctl kickstart -k gui/\$(id -u)/$SERVICE_LABEL"
      elif launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
        launchctl kickstart -k "gui/$(id -u)/$SERVICE_LABEL"
      else
        log "Service $SERVICE_LABEL is not loaded; skipping restart."
      fi
      ;;
    linux)
      if [[ "$DRY_RUN" == "1" ]]; then
        log "[dry-run] systemctl --user restart $LINUX_UNIT"
      elif systemctl --user list-unit-files "$LINUX_UNIT.service" >/dev/null 2>&1; then
        systemctl --user restart "$LINUX_UNIT"
      else
        log "Service $LINUX_UNIT is not installed; skipping restart."
      fi
      ;;
    *) log "Unsupported OS; skipping restart." ;;
  esac
}

[[ -d "$APP_DIR/.git" || "$DRY_RUN" == "1" ]] || die "App checkout not found: $APP_DIR"
[[ -d "$INSTANCE_DIR" || "$DRY_RUN" == "1" ]] || die "Instance not found: $INSTANCE_DIR"

log "Updating Skoobi app"
log "app: $APP_DIR"
log "instance: $INSTANCE_DIR"
log "ref: $REF"

run mkdir -p "$BACKUP_DIR"
current_ref=""
if [[ -d "$APP_DIR/.git" ]]; then
  current_ref="$(git -C "$APP_DIR" rev-parse HEAD)"
  if [[ "$DRY_RUN" == "0" ]]; then
    printf '%s\n' "$current_ref" >"$BACKUP_DIR/app-ref-before-update-$(date +%Y%m%d%H%M%S).txt"
  else
    log "[dry-run] record current app ref: $current_ref"
  fi
fi

rollback_app() {
  [[ -n "$current_ref" ]] || return 0
  log "Build failed; rolling app checkout back to $current_ref"
  git -C "$APP_DIR" checkout "$current_ref" >/dev/null 2>&1 || true
}
trap 'rollback_app' ERR

run git -C "$APP_DIR" fetch --tags --prune origin
run git -C "$APP_DIR" checkout "$REF"
run npm --prefix "$APP_DIR" ci
run npm --prefix "$APP_DIR" run build
if [[ -f "$APP_DIR/agent/runner/package.json" || "$DRY_RUN" == "1" ]]; then
  run npm --prefix "$APP_DIR/agent/runner" ci
  run npm --prefix "$APP_DIR/agent/runner" run build
fi
trap - ERR

restart_service

log "Skoobi update complete."
