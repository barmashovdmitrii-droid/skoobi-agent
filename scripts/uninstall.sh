#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CANONICAL_REPO="https://github.com/barmashovdmitrii-droid/skoobi-agent.git"
PREFIX="${SKOOBI_PREFIX:-$HOME/.skoobi}"
INSTANCE="default"
PURGE=0
YES=0
FORCE=0
DRY_RUN=0
APP_NAME="skoobi-agent"
GIT_HOME=""
OWNER_BACKUP_DONE=0
LOCK_DIR=""
LOCK_HELD=0
PURGE_ENV_BACKUPS=()

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
  --purge            Also delete instance data after exact confirmation
  --yes              Confirm a requested forced app removal
  --force            Back up owner changes or quarantine an unverified app
  --dry-run          Print planned actions without changing files
  --help             Show this help

Default behavior removes only a verified managed app, its owned CLI link, and
its stopped service. It preserves instance .env, groups, store, logs, and data.
Untracked or ignored owner files make default uninstall fail closed.

With --force --yes, verified owner changes are backed up before removal. An
unverified app directory is moved intact into the owner-only backups directory
instead of being deleted.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; [[ -n "$PREFIX" ]] || die "--prefix requires a path"; shift 2 ;;
    --instance) INSTANCE="${2:-}"; [[ -n "$INSTANCE" ]] || die "--instance requires a name"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option" ;;
  esac
done

case "$INSTANCE" in
  *[!A-Za-z0-9_-]*|'') die "Instance name must contain only letters, digits, _ or -" ;;
esac
[[ ${#INSTANCE} -le 63 ]] ||
  die "Instance name must be at most 63 characters"
case "$INSTANCE" in
  [Dd][Aa][Ss][Hh][Bb][Oo][Aa][Rr][Dd])
    die "Instance name 'dashboard' is reserved"
    ;;
esac
case "$PREFIX" in
  *$'\n'*|*$'\r'*) die "Install prefix must not contain newlines" ;;
esac
case "$HOME" in
  *$'\n'*|*$'\r'*) die "HOME must not contain newlines" ;;
esac

PREFIX="${PREFIX/#\~/$HOME}"
[[ "$PREFIX" == /* ]] || PREFIX="$PWD/$PREFIX"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ -d "$PREFIX" ]] || die "Install prefix not found"
  [[ ! -L "$PREFIX" ]] || die "Refusing a symlinked install prefix"
  PREFIX="$(cd "$PREFIX" && pwd -P)"
fi
APP_BASE="$PREFIX/app"
APP_DIR="$APP_BASE/$APP_NAME"
MANAGED_APP_NAME="$APP_NAME"
INSTANCE_ROOT="$PREFIX/instances"
INSTANCE_DIR="$INSTANCE_ROOT/$INSTANCE"
BACKUP_DIR="$PREFIX/backups"
BACKUP_INSTANCE_ROOT="$BACKUP_DIR/instances"
INSTANCE_BACKUP_DIR="$BACKUP_INSTANCE_ROOT/$INSTANCE"
MARKER_FILE="$PREFIX/.skoobi-managed-install"
SERVICE_LABEL="com.skoobi.$INSTANCE"
MACOS_PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
LINUX_UNIT="$HOME/.config/systemd/user/skoobi-$INSTANCE.service"
CLI_LINK="$HOME/.local/bin/skoobi"
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

acquire_operation_lock() {
  LOCK_DIR="$PREFIX/.skoobi-operation.lock"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] acquire exclusive installer operation lock"
    return 0
  fi
  mkdir "$LOCK_DIR" 2>/dev/null ||
    die "Another Skoobi install, update, or uninstall operation is in progress"
  LOCK_HELD=1
}

release_operation_lock() {
  [[ "$LOCK_HELD" == "1" ]] || return 0
  rmdir "$LOCK_DIR" ||
    die "Could not release the installer operation lock"
  LOCK_HELD=0
}

ensure_git_home() {
  if [[ -z "$GIT_HOME" ]]; then
    GIT_HOME="$(mktemp -d "${TMPDIR:-/tmp}/skoobi-git-home.XXXXXXXX")"
    chmod 700 "$GIT_HOME"
  fi
}

git_safe() {
  ensure_git_home
  local -a clean_env=(
    env -i
    "HOME=$GIT_HOME"
    "PATH=$PATH"
    "TMPDIR=${TMPDIR:-/tmp}"
    "LANG=${LANG:-C}"
    "LC_ALL=${LC_ALL:-C}"
    GIT_CONFIG_NOSYSTEM=1
    GIT_CONFIG_GLOBAL=/dev/null
    GIT_CONFIG_COUNT=0
    GIT_NO_REPLACE_OBJECTS=1
    GIT_TERMINAL_PROMPT=0
  )
  "${clean_env[@]}" git --no-replace-objects \
    -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false \
    -c submodule.recurse=false \
    "$@"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *) echo "unsupported" ;;
  esac
}

# Return 0 when the job is loaded, 3 only when launchd can prove that the
# containing user domain is reachable but the label is absent, and 1 when the
# state is unknown (for example, a transport or permission failure).
launchd_job_state() {
  local target="$1" domain="${1%/*}" status
  if launchctl print "$target" >/dev/null 2>&1; then
    return 0
  else
    status=$?
  fi
  [[ "$status" == "113" ]] || return 1
  launchctl print "$domain" >/dev/null 2>&1 || return 1
  return 3
}

marker_content() {
  printf 'format=1\nrepository=%s\napp=%s\n' \
    "$CANONICAL_REPO" "$MANAGED_APP_NAME"
}

valid_marker() {
  [[ -f "$MARKER_FILE" && ! -L "$MARKER_FILE" ]] || return 1
  [[ "$(cat "$MARKER_FILE")" == "$(marker_content)" ]]
}

sha256_file() {
  local file="$1" output=""
  if command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256 <"$file")" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum <"$file")" || return 1
  else
    return 1
  fi
  printf '%s' "${output%% *}"
}

is_husky_generated_file() {
  local app_root="$1" rel="$2" file="$1/$2" expected_hash="" actual_hash=""
  [[ -f "$file" && ! -L "$file" ]] || return 1
  case "$rel" in
    .husky/_/.gitignore)
      expected_hash="684888c0ebb17f374298b65ee2807526c066094c701bcc7ebbe1c1095f494fc1"
      ;;
    .husky/_/h)
      expected_hash="70200b200ca709b0622784f93839a5b2872333a917a09afddefd7dc2d8cdc680"
      ;;
    .husky/_/husky.sh)
      expected_hash="21122903fca7209a13c991e5be68780636e28f1b8f0ae7ea07ed0065dfe37268"
      ;;
    .husky/_/applypatch-msg|.husky/_/commit-msg|.husky/_/post-applypatch|\
      .husky/_/post-checkout|.husky/_/post-commit|.husky/_/post-merge|\
      .husky/_/post-rewrite|.husky/_/pre-applypatch|.husky/_/pre-auto-gc|\
      .husky/_/pre-commit|.husky/_/pre-merge-commit|.husky/_/pre-push|\
      .husky/_/pre-rebase|.husky/_/prepare-commit-msg)
      expected_hash="34fe496008be71d8fdd446b2cce81e4bb0406109c130eafc583fbd9fe33244e2"
      ;;
    *) return 1 ;;
  esac
  actual_hash="$(sha256_file "$file")" || return 1
  [[ "$actual_hash" == "$expected_hash" ]]
}

is_ephemeral_ignored_path() {
  local app_root="$1" rel="$2"
  is_husky_generated_file "$app_root" "$rel" && return 0
  case "$rel" in
    node_modules/*|*/node_modules/*|dist/*|*/dist/*|coverage/*|*/coverage/*|\
      .vite/*|*/.vite/*|*.tsbuildinfo|*/.DS_Store|.DS_Store)
      return 0
      ;;
    *) return 1 ;;
  esac
}

has_owner_ignored_files() {
  local rel listing found=1
  ensure_git_home
  listing="$(mktemp "$GIT_HOME/ignored.XXXXXXXX")"
  git_safe -C "$APP_DIR" ls-files --others --ignored --exclude-standard -z >"$listing" ||
    die "Could not inspect ignored files in the managed app"
  while IFS= read -r -d '' rel; do
    if ! is_ephemeral_ignored_path "$APP_DIR" "$rel"; then
      found=0
      break
    fi
  done <"$listing"
  rm -f "$listing"
  return "$found"
}

has_gitlinks() {
  local entry listing found=1
  ensure_git_home
  listing="$(mktemp "$GIT_HOME/gitlinks.XXXXXXXX")"
  git_safe -C "$APP_DIR" ls-files --stage -z >"$listing" ||
    die "Could not inspect Git entries in the managed app"
  while IFS= read -r -d '' entry; do
    if [[ "${entry%% *}" == "160000" ]]; then
      found=0
      break
    fi
  done <"$listing"
  rm -f "$listing"
  return "$found"
}

has_special_files() {
  local found rel listing result=1
  ensure_git_home
  listing="$(mktemp "$GIT_HOME/special.XXXXXXXX")"
  find "$APP_DIR" -xdev -path "$APP_DIR/.git" -prune -o \
    \( -type p -o -type s -o -type b -o -type c \) -print0 >"$listing" ||
    die "Could not inspect special files in the managed app"
  while IFS= read -r -d '' found; do
    rel="${found#"$APP_DIR"/}"
    if [[ "$rel" == "$found" ]] ||
        ! is_ephemeral_ignored_path "$APP_DIR" "$rel"; then
      result=0
      break
    fi
  done <"$listing"
  rm -f "$listing"
  return "$result"
}

git_status_output() {
  GIT_STATUS_OUTPUT="$(git_safe -C "$APP_DIR" status --porcelain --untracked-files=normal)" ||
    die "Could not inspect managed app status"
}

assert_owner_backup_supported() {
  ! has_gitlinks ||
    die "Refusing uninstall because Git submodules may contain owner data"
  ! has_special_files ||
    die "Refusing uninstall because FIFO, socket, or device files cannot be safely backed up"
}

assert_safe_relative_path() {
  case "$1" in
    /*|..|../*|*/../*|*/..) die "Unsafe owner file path in app checkout" ;;
  esac
}

assert_no_symlink_parents() {
  local rel="$1" part current="$APP_DIR"
  IFS='/' read -r -a parts <<<"$rel"
  for part in "${parts[@]:0:${#parts[@]}-1}"; do
    current="$current/$part"
    [[ ! -L "$current" ]] ||
      die "Refusing to follow a symlink while backing up owner files"
  done
}

copy_owner_file() {
  local backup_root="$1" rel="$2" source target
  assert_safe_relative_path "$rel"
  assert_no_symlink_parents "$rel"
  source="$APP_DIR/$rel"
  target="$backup_root/files/$rel"
  [[ -f "$source" || -L "$source" ]] ||
    die "Unsupported owner file type in app checkout"
  mkdir -p "$(dirname "$target")"
  cp -pP "$source" "$target"
}

backup_owner_changes() {
  local backup_dir rel untracked_listing ignored_listing
  assert_owner_backup_supported
  backup_dir="$(mktemp -d "$BACKUP_DIR/uninstall-owner-changes-XXXXXXXX")"
  chmod 700 "$backup_dir"
  mkdir -p "$backup_dir/files"
  git_safe -C "$APP_DIR" diff --no-ext-diff --no-textconv --binary HEAD >"$backup_dir/tracked.patch"
  chmod 600 "$backup_dir/tracked.patch"
  git_safe -C "$APP_DIR" status --short --ignored >"$backup_dir/status.txt"
  chmod 600 "$backup_dir/status.txt"
  ensure_git_home
  untracked_listing="$(mktemp "$GIT_HOME/untracked.XXXXXXXX")"
  ignored_listing="$(mktemp "$GIT_HOME/ignored-owner.XXXXXXXX")"
  git_safe -C "$APP_DIR" ls-files --others --exclude-standard -z >"$untracked_listing" ||
    die "Could not enumerate untracked owner files"
  git_safe -C "$APP_DIR" ls-files --others --ignored --exclude-standard -z >"$ignored_listing" ||
    die "Could not enumerate ignored owner files"
  while IFS= read -r -d '' rel; do
    copy_owner_file "$backup_dir" "$rel"
  done <"$untracked_listing"
  while IFS= read -r -d '' rel; do
    is_ephemeral_ignored_path "$APP_DIR" "$rel" ||
      copy_owner_file "$backup_dir" "$rel"
  done <"$ignored_listing"
  rm -f "$untracked_listing" "$ignored_listing"
  log "Owner changes backed up without following symlinks: $backup_dir"
}

assert_managed_paths() {
  [[ ! -L "$APP_BASE" && ! -L "$APP_DIR" && ! -L "$INSTANCE_ROOT" &&
      ! -L "$INSTANCE_DIR" && ! -L "$BACKUP_DIR" && ! -L "$MARKER_FILE" ]] ||
    die "Refusing to remove through a symlinked managed path"
  if [[ "$PURGE" == "1" ]]; then
    [[ ! -L "$BACKUP_INSTANCE_ROOT" && ! -L "$INSTANCE_BACKUP_DIR" ]] ||
      die "Refusing to purge through a symlinked instance backup path"
  fi
  case "$APP_DIR" in
    "$APP_BASE/$APP_NAME") ;;
    *) die "Refusing an app path outside the managed layout" ;;
  esac
  [[ "$INSTANCE_DIR" == "$INSTANCE_ROOT/$INSTANCE" ]] ||
    die "Refusing an instance path outside the managed layout"
  [[ "$APP_DIR" != "/" && "$INSTANCE_DIR" != "/" ]] ||
    die "Refusing to remove a filesystem root"

  local service_file relative_dir
  [[ -d "$HOME" && ! -L "$HOME" ]] ||
    die "HOME must be a real directory"
  if [[ "$(detect_os)" == "macos" ]]; then
    service_file="$MACOS_PLIST"
    relative_dir="Library/LaunchAgents"
  else
    service_file="$LINUX_UNIT"
    relative_dir=".config/systemd/user"
  fi
  if [[ -e "$service_file" || -L "$service_file" ]]; then
    assert_home_directory_chain "$relative_dir"
  fi
  [[ ! -L "$service_file" ]] ||
    die "Refusing to remove a symlinked service file"
  [[ ! -e "$service_file" || -f "$service_file" ]] ||
    die "Refusing to remove a non-regular service file"
}

assert_home_directory_chain() {
  local relative="$1" current="$HOME" part
  local -a parts
  IFS='/' read -r -a parts <<<"$relative"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != "." && "$part" != ".." ]] ||
      die "Unsafe directory path below HOME"
    current="$current/$part"
    [[ ! -L "$current" ]] ||
      die "Refusing to use a symlinked directory ancestor below HOME"
    [[ ! -e "$current" || -d "$current" ]] ||
      die "Directory ancestor below HOME is not a directory"
  done
}

APP_VERIFIED=0
APP_DIRTY=0
assess_app() {
  [[ -e "$APP_DIR" ]] || return 0
  if [[ -d "$APP_DIR/.git" && ! -L "$APP_DIR/.git" ]]; then
    local origin
    origin="$(git_safe -C "$APP_DIR" config --local --get-all remote.origin.url 2>/dev/null || true)"
    if [[ "$origin" == "$CANONICAL_REPO" ]] && valid_marker; then
      APP_VERIFIED=1
      git_status_output
      [[ -z "$GIT_STATUS_OUTPUT" ]] ||
        APP_DIRTY=1
      if has_owner_ignored_files; then
        APP_DIRTY=1
      fi
      if has_gitlinks || has_special_files; then
        APP_DIRTY=1
      fi
    fi
  fi
  return 0
}

confirm_force() {
  [[ "$YES" == "1" ]] && return 0
  [[ "$DRY_RUN" == "1" ]] && {
    log "[dry-run] require explicit confirmation for forced removal"
    return 0
  }
  local answer=""
  read -r -p "Back up/quarantine app contents and continue? [y/N]: " answer || true
  [[ "$answer" =~ ^(y|Y|yes|YES)$ ]] ||
    die "Forced uninstall was not confirmed"
}

confirm_purge() {
  [[ "$PURGE" == "1" && "$DRY_RUN" == "0" ]] || return 0
  local confirmation="${SKOOBI_PURGE_CONFIRMATION:-}"
  if [[ -z "$confirmation" ]]; then
    log "This will permanently delete instance data:"
    log "  $INSTANCE_DIR"
    if [[ "${#PURGE_ENV_BACKUPS[@]}" -gt 0 ]]; then
      log "It will also delete ${#PURGE_ENV_BACKUPS[@]} validated instance .env backup(s)."
    fi
    read -r -p "Type DELETE Skoobi data to continue: " confirmation || true
  fi
  [[ "$confirmation" == "DELETE Skoobi data" ]] ||
    die "Purge confirmation did not match; nothing was removed"
}

prepare_purge_instance_env_backups() {
  [[ "$PURGE" == "1" ]] || return 0
  local backup entry name
  PURGE_ENV_BACKUPS=()
  if [[ -e "$INSTANCE_BACKUP_DIR" || -L "$INSTANCE_BACKUP_DIR" ]]; then
    [[ -d "$INSTANCE_BACKUP_DIR" && ! -L "$INSTANCE_BACKUP_DIR" ]] ||
      die "Instance backup path is not a safe real directory"
    for entry in "$INSTANCE_BACKUP_DIR"/* "$INSTANCE_BACKUP_DIR"/.*; do
      [[ -e "$entry" || -L "$entry" ]] || continue
      name="$(basename "$entry")"
      [[ "$name" != "." && "$name" != ".." ]] || continue
      [[ "$name" =~ ^env\.bak\.[A-Za-z0-9]{8}$ &&
          -f "$entry" && ! -L "$entry" ]] ||
        die "Instance backup directory contains an unexpected file; purge stopped before removal"
      PURGE_ENV_BACKUPS+=("$entry")
    done
  fi
  for backup in "$BACKUP_DIR/${INSTANCE}.env.bak."*; do
    [[ -e "$backup" || -L "$backup" ]] || continue
    name="$(basename "$backup")"
    [[ "$name" =~ ^${INSTANCE}\.env\.bak\.[A-Za-z0-9]{8}$ &&
        -f "$backup" && ! -L "$backup" ]] ||
      die "Legacy instance backup path is unexpected; purge stopped before removal"
    PURGE_ENV_BACKUPS+=("$backup")
  done
}

purge_instance_env_backups() {
  [[ "$PURGE" == "1" ]] || return 0
  local backup count=0
  if [[ "${#PURGE_ENV_BACKUPS[@]}" -gt 0 ]]; then
    for backup in "${PURGE_ENV_BACKUPS[@]}"; do
      run rm -f -- "$backup"
      count=$((count + 1))
    done
  fi
  if [[ -d "$INSTANCE_BACKUP_DIR" && ! -L "$INSTANCE_BACKUP_DIR" ]]; then
    run rmdir "$INSTANCE_BACKUP_DIR"
  fi
  log "Removed $count instance .env backup(s)."
}

stop_service_and_prove() {
  local os_name
  os_name="$(detect_os)"
  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ "$os_name" == "macos" ]]; then
      log "[dry-run] disable KeepAlive, bootout, and prove launchd service stopped"
    elif [[ "$os_name" == "linux" ]]; then
      log "[dry-run] disable --now and prove systemd user service inactive"
    fi
    return 0
  fi

  if [[ "$os_name" == "macos" ]]; then
    local status target
    target="gui/$(id -u)/$SERVICE_LABEL"
    if command -v launchctl >/dev/null 2>&1; then
      launchctl disable "$target" >/dev/null 2>&1 || true
      launchctl bootout "$target" >/dev/null 2>&1 || true
      if launchd_job_state "$target"; then
        die "launchd service is still loaded; no files were removed"
      else
        status=$?
        [[ "$status" == "3" ]] ||
          die "launchd could not prove the service stopped; no files were removed"
      fi
    elif [[ -e "$MACOS_PLIST" ]]; then
      die "launchctl is required to prove the service stopped"
    fi
  elif [[ "$os_name" == "linux" ]]; then
    if ! command -v systemctl >/dev/null 2>&1; then
      [[ ! -e "$LINUX_UNIT" && ! -L "$LINUX_UNIT" ]] ||
        die "systemctl is required to prove the service stopped"
      return 0
    fi
    local status
    if systemctl --user is-active --quiet "skoobi-$INSTANCE"; then
      status=0
    else
      status=$?
    fi
    if [[ ! -e "$LINUX_UNIT" && ! -L "$LINUX_UNIT" ]]; then
      case "$status" in
        3|4) return 0 ;;
        0)
          systemctl --user stop "skoobi-$INSTANCE" >/dev/null 2>&1 ||
            die "systemd could not stop the definition-less service; no files were removed"
          ;;
        *) die "systemd could not prove the definition-less service is inactive; no files were removed" ;;
      esac
    else
      systemctl --user disable --now "skoobi-$INSTANCE" >/dev/null 2>&1 ||
        die "systemd could not stop and disable the service; no files were removed"
    fi
    if systemctl --user is-active --quiet "skoobi-$INSTANCE"; then
      status=0
    else
      status=$?
    fi
    case "$status" in
      3|4) ;;
      0) die "systemd service is still active; no files were removed" ;;
      *) die "systemd could not prove the service stopped; no files were removed" ;;
    esac
  fi
}

remove_service_file() {
  if [[ "$(detect_os)" == "macos" ]]; then
    run rm -f "$MACOS_PLIST"
  else
    run rm -f "$LINUX_UNIT"
    if [[ "$DRY_RUN" == "0" ]] && command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
  fi
}

remove_owned_cli_link() {
  [[ -L "$CLI_LINK" ]] || return 0
  local current_target
  current_target="$(readlink "$CLI_LINK" 2>/dev/null || true)"
  if [[ "$current_target" == "$CLI_TARGET" ]]; then
    run rm -f "$CLI_LINK"
    log "Removed owned Skoobi CLI symlink."
  else
    log "Preserving CLI symlink not owned by this installation."
  fi
}

remove_or_quarantine_app() {
  [[ -e "$APP_DIR" ]] || return 0
  if [[ "$APP_VERIFIED" == "1" ]]; then
    if [[ "$APP_DIRTY" == "1" && "$OWNER_BACKUP_DONE" == "0" ]]; then
      backup_owner_changes
    fi
    run rm -rf "$APP_DIR"
    return 0
  fi

  local quarantine_root quarantine
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] move unverified app into a private unpredictable quarantine directory"
    return 0
  fi
  quarantine_root="$(mktemp -d "$BACKUP_DIR/unverified-app-XXXXXXXX")"
  chmod 700 "$quarantine_root"
  quarantine="$quarantine_root/$MANAGED_APP_NAME"
  mv "$APP_DIR" "$quarantine"
  log "Unverified app was quarantined intact: $quarantine"
}

assert_quarantine_same_filesystem() {
  local app_device backup_device
  if [[ "$(detect_os)" == "macos" ]]; then
    app_device="$(/usr/bin/stat -f '%d' "$APP_DIR")"
    backup_device="$(/usr/bin/stat -f '%d' "$BACKUP_DIR")"
  else
    app_device="$(/usr/bin/stat -c '%d' "$APP_DIR")"
    backup_device="$(/usr/bin/stat -c '%d' "$BACKUP_DIR")"
  fi
  [[ -n "$app_device" && "$app_device" == "$backup_device" ]] ||
    die "Unverified app quarantine must be on the same filesystem"
}

cleanup() {
  local status
  status="$1"
  [[ -z "$GIT_HOME" || ! -e "$GIT_HOME" ]] || rm -rf "$GIT_HOME"
  if [[ "$LOCK_HELD" == "1" ]]; then
    rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
    LOCK_HELD=0
  fi
  return "$status"
}
trap 'cleanup $?' EXIT

main() {
  log "Uninstalling Skoobi"
  log "app: $APP_DIR"
  log "instance: $INSTANCE_DIR"

  assert_managed_paths
  acquire_operation_lock
  run mkdir -p "$BACKUP_DIR"
  run chmod 700 "$PREFIX" "$BACKUP_DIR"
  [[ "$DRY_RUN" == "1" ]] || assess_app

  if [[ "$DRY_RUN" == "0" && -e "$APP_DIR" ]]; then
    if [[ "$APP_VERIFIED" != "1" || "$APP_DIRTY" == "1" ]]; then
      [[ "$FORCE" == "1" ]] ||
        die "App is unverified or contains owner changes; uninstall refused without --force"
      confirm_force
    elif [[ "$FORCE" == "1" ]]; then
      log "Verified app has no owner changes; forced removal is unnecessary."
    fi
  fi
  prepare_purge_instance_env_backups
  confirm_purge
  if [[ "$DRY_RUN" == "0" && -e "$APP_DIR" &&
      "$APP_VERIFIED" != "1" ]]; then
    assert_quarantine_same_filesystem
  fi
  if [[ "$APP_VERIFIED" == "1" && "$APP_DIRTY" == "1" ]]; then
    backup_owner_changes
    OWNER_BACKUP_DONE=1
  fi

  stop_service_and_prove
  remove_service_file
  remove_owned_cli_link
  remove_or_quarantine_app

  if [[ "$APP_VERIFIED" == "1" && -f "$MARKER_FILE" ]]; then
    run rm -f "$MARKER_FILE"
  elif [[ -e "$MARKER_FILE" ]]; then
    log "Preserving unverified managed-install marker."
  fi

  if [[ "$PURGE" == "1" ]]; then
    run rm -rf "$INSTANCE_DIR"
    purge_instance_env_backups
    log "Other safety backups are preserved in: $BACKUP_DIR"
  else
    log "Instance data preserved: $INSTANCE_DIR"
    log "Safety backups preserved in: $BACKUP_DIR"
    log "Use --purge only after backup and exact confirmation."
  fi
  release_operation_lock
  log "Skoobi uninstall complete."
}

main "$@"
