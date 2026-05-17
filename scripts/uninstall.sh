#!/usr/bin/env bash
set -euo pipefail

PREFIX="${SKOOBI_PREFIX:-$HOME/.skoobi}"
INSTANCE="default"
PURGE=0
YES=0
DRY_RUN=0
APP_NAME="skoobi-agent"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Skoobi uninstaller

Usage:
  scripts/uninstall.sh [options]

Options:
  --prefix <path>    Install prefix (default: ~/.skoobi)
  --instance <name>  Instance name (default: default)
  --purge            Also delete instance data after explicit confirmation
  --yes              Non-interactive defaults; still requires purge confirmation
  --dry-run          Print planned actions without changing files
  --help             Show this help

Default behavior removes service files and app code only. It keeps instance
data: .env, groups, store, logs, and data.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; [[ -n "$PREFIX" ]] || die "--prefix requires a path"; shift 2 ;;
    --instance) INSTANCE="${2:-}"; [[ -n "$INSTANCE" ]] || die "--instance requires a name"; shift 2 ;;
    --purge) PURGE=1; shift ;;
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
SERVICE_LABEL="com.skoobi.$INSTANCE"
MACOS_PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
LINUX_UNIT="$HOME/.config/systemd/user/skoobi-$INSTANCE.service"

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

stop_service() {
  case "$(detect_os)" in
    macos)
      if [[ "$DRY_RUN" == "1" ]]; then
        log "[dry-run] launchctl bootout gui/\$(id -u) $MACOS_PLIST"
      else
        launchctl bootout "gui/$(id -u)" "$MACOS_PLIST" >/dev/null 2>&1 || true
      fi
      ;;
    linux)
      if [[ "$DRY_RUN" == "1" ]]; then
        log "[dry-run] systemctl --user disable --now skoobi-$INSTANCE"
      else
        systemctl --user disable --now "skoobi-$INSTANCE" >/dev/null 2>&1 || true
        rm -f "$LINUX_UNIT"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
      fi
      ;;
  esac
}

log "Uninstalling Skoobi"
log "app: $APP_DIR"
log "instance: $INSTANCE_DIR"

stop_service

if [[ "$(detect_os)" == "macos" ]]; then
  run rm -f "$MACOS_PLIST"
fi

if [[ -d "$APP_DIR" || "$DRY_RUN" == "1" ]]; then
  run rm -rf "$APP_DIR"
fi

if [[ "$PURGE" == "1" ]]; then
  confirmation="${SKOOBI_PURGE_CONFIRMATION:-}"
  if [[ -z "$confirmation" && "$DRY_RUN" == "0" ]]; then
    log "This will permanently delete instance data:"
    log "  $INSTANCE_DIR"
    read -r -p "Type DELETE Skoobi data to continue: " confirmation || true
  fi
  if [[ "$confirmation" != "DELETE Skoobi data" && "$DRY_RUN" == "0" ]]; then
    die "Purge confirmation did not match; instance data preserved."
  fi
  run rm -rf "$INSTANCE_DIR"
else
  log "Instance data preserved: $INSTANCE_DIR"
  log "Use --purge only after backup and explicit confirmation."
fi

log "Skoobi uninstall complete."
