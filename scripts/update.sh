#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CANONICAL_REPO="https://github.com/barmashovdmitrii-droid/skoobi-agent.git"
PREFIX="${SKOOBI_PREFIX:-$HOME/.skoobi}"
INSTANCE="default"
REF="${SKOOBI_UPDATE_REF:-main}"
EXPECTED_COMMIT="${SKOOBI_UPDATE_EXPECTED_COMMIT:-}"
NO_START=0
YES=0
FORCE=0
DRY_RUN=0
ADOPT_MANAGED=0
APP_NAME="skoobi-agent"

STAGE_DIR=""
OLD_RELEASE=""
OLD_RELEASE_ROOT=""
UPDATE_SUCCEEDED=0
BUILD_HOME=""
GIT_HOME=""
LOCK_DIR=""
LOCK_HELD=0

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
  --ref <branch/tag>     Public branch or tag (default: main)
  --expected-commit <id> Require the resolved ref to match this 40-hex commit
  --no-start             Do not restart the service after activation
  --yes                  Confirm a requested forced replacement
  --force                Back up owner changes, then replace the app release
  --adopt-managed        Adopt a verified old public install missing its marker
  --dry-run              Print planned actions without changing files
  --help                 Show this help

The updater never builds inside the active release. It builds a fresh staged
checkout, verifies its exact commit, and atomically switches releases. Instance
.env, groups, store, logs, and data are never modified.

Legacy app directories must first be preserved explicitly with:
  scripts/install.sh --migrate-legacy <directory-name>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; [[ -n "$PREFIX" ]] || die "--prefix requires a path"; shift 2 ;;
    --instance) INSTANCE="${2:-}"; [[ -n "$INSTANCE" ]] || die "--instance requires a name"; shift 2 ;;
    --ref) REF="${2:-}"; [[ -n "$REF" ]] || die "--ref requires a branch or tag"; shift 2 ;;
    --expected-commit) EXPECTED_COMMIT="${2:-}"; [[ -n "$EXPECTED_COMMIT" ]] || die "--expected-commit requires a commit"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --adopt-managed) ADOPT_MANAGED=1; shift ;;
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
case "$REF" in
  -*|*:*|*' '*|*$'\t'*|*$'\n'*|*$'\r'*|*~*|*^*|*\?*|*\**|*\[*|*\\*)
    die "Git ref contains unsafe characters"
    ;;
esac
[[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] ||
  die "Git ref contains unsafe characters"
case "$REF" in
  *..*|*//*|*/.|*.lock|*/) die "Git ref is not a valid branch or tag name" ;;
esac
if [[ -n "$EXPECTED_COMMIT" ]]; then
  [[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
    die "Expected commit must be exactly 40 lowercase hexadecimal characters"
fi
case "$PREFIX" in
  *$'\n'*|*$'\r'*) die "Install prefix must not contain newlines" ;;
esac
case "$HOME" in
  *$'\n'*|*$'\r'*) die "HOME must not contain newlines" ;;
esac

PREFIX="${PREFIX/#\~/$HOME}"
[[ "$PREFIX" == /* ]] || PREFIX="$PWD/$PREFIX"
APP_BASE="$PREFIX/app"
APP_DIR="$APP_BASE/$APP_NAME"
INSTANCE_ROOT="$PREFIX/instances"
INSTANCE_DIR="$INSTANCE_ROOT/$INSTANCE"
BACKUP_DIR="$PREFIX/backups"
MARKER_FILE="$PREFIX/.skoobi-managed-install"
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

safe_npm() {
  local npm_userconfig status=0
  if [[ -z "$BUILD_HOME" ]]; then
    BUILD_HOME="$(mktemp -d "${TMPDIR:-/tmp}/skoobi-build-home.XXXXXXXX")"
    chmod 700 "$BUILD_HOME"
  fi
  npm_userconfig="$BUILD_HOME/npmrc"
  touch "$npm_userconfig"
  chmod 600 "$npm_userconfig"
  env -i \
    HOME="$BUILD_HOME" \
    PATH="$PATH" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LANG="${LANG:-C}" \
    LC_ALL="${LC_ALL:-C}" \
    NPM_CONFIG_CACHE="$BUILD_HOME/npm-cache" \
    NPM_CONFIG_USERCONFIG="$npm_userconfig" \
    NPM_CONFIG_GLOBALCONFIG=/dev/null \
    npm "$@" || status=$?
  return "$status"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *) echo "unsupported" ;;
  esac
}

marker_content() {
  printf 'format=1\nrepository=%s\napp=%s\n' "$CANONICAL_REPO" "$APP_NAME"
}

valid_marker() {
  [[ -f "$MARKER_FILE" && ! -L "$MARKER_FILE" ]] || return 1
  [[ "$(cat "$MARKER_FILE")" == "$(marker_content)" ]]
}

write_marker() {
  [[ "$DRY_RUN" == "0" ]] || {
    log "[dry-run] atomically write managed-install marker"
    return 0
  }
  [[ ! -L "$MARKER_FILE" ]] ||
    die "Refusing to replace a symlinked managed-install marker"
  local tmp
  tmp="$(mktemp "$PREFIX/.skoobi-managed-install.XXXXXXXX")"
  marker_content >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$MARKER_FILE"
}

validate_origin() {
  local origin
  origin="$(git_safe -C "$APP_DIR" config --local --get-all remote.origin.url 2>/dev/null || true)"
  [[ "$origin" == "$CANONICAL_REPO" ]] ||
    die "Managed app origin is not the canonical public HTTPS repository"
}

is_ephemeral_ignored_path() {
  case "$1" in
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
    if ! is_ephemeral_ignored_path "$rel"; then
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
  git_safe -C "$1" ls-files --stage -z >"$listing" ||
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

git_status_output() {
  GIT_STATUS_OUTPUT="$(git_safe -C "$1" status --porcelain --untracked-files=normal)" ||
    die "Could not inspect managed app status"
}

has_special_files() {
  local found listing result=1
  ensure_git_home
  listing="$(mktemp "$GIT_HOME/special.XXXXXXXX")"
  find "$APP_DIR" -xdev -path "$APP_DIR/.git" -prune -o \
    \( -type p -o -type s -o -type b -o -type c \) -print0 >"$listing" ||
    die "Could not inspect special files in the managed app"
  while IFS= read -r -d '' found; do
    result=0
    break
  done <"$listing"
  rm -f "$listing"
  return "$result"
}

assert_real_git_checkout() {
  [[ -d "$APP_DIR" && ! -L "$APP_DIR" ]] ||
    die "Managed app path must be a real directory"
  [[ -d "$APP_DIR/.git" && ! -L "$APP_DIR/.git" ]] ||
    die "Managed app .git must be a real directory"
}

verify_published_commit() {
  local commit probe_dir fetched
  commit="$(git_safe -C "$APP_DIR" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] ||
    die "Managed app HEAD is not an exact commit"
  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/skoobi-adoption-probe.XXXXXXXX")"
  chmod 700 "$probe_dir"
  if ! git_safe -C "$probe_dir" init -q --template= ||
    ! git_safe -C "$probe_dir" remote add origin "$CANONICAL_REPO" ||
    ! git_safe -C "$probe_dir" fetch --depth=1 origin "$commit" >/dev/null 2>&1; then
    rm -rf "$probe_dir"
    die "Managed app commit is not published by the canonical repository"
  fi
  fetched="$(git_safe -C "$probe_dir" rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null || true)"
  rm -rf "$probe_dir"
  [[ "$fetched" == "$commit" ]] ||
    die "Managed app commit could not be verified against the canonical repository"
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
  ! has_gitlinks "$APP_DIR" ||
    die "Refusing forced update because Git submodules may contain owner data"
  ! has_special_files ||
    die "Refusing forced update because FIFO, socket, or device files cannot be safely backed up"
  backup_dir="$(mktemp -d "$BACKUP_DIR/app-owner-changes-XXXXXXXX")"
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
    is_ephemeral_ignored_path "$rel" ||
      copy_owner_file "$backup_dir" "$rel"
  done <"$ignored_listing"
  rm -f "$untracked_listing" "$ignored_listing"
  log "Owner changes backed up without following symlinks: $backup_dir"
}

confirm_force() {
  [[ "$FORCE" == "1" ]] || return 0
  [[ "$YES" == "1" ]] && return 0
  [[ "$DRY_RUN" == "1" ]] && {
    log "[dry-run] require explicit confirmation before forced replacement"
    return 0
  }
  local answer=""
  read -r -p "Back up owner changes and replace the app release? [y/N]: " answer || true
  [[ "$answer" =~ ^(y|Y|yes|YES)$ ]] ||
    die "Forced update was not confirmed"
}

resolve_advertised_commit() {
  local repo_dir="$1" target_kind="$2" target_ref="$3"
  local output status
  if [[ "$target_kind" == "tag" ]]; then
    if output="$(git_safe -C "$repo_dir" ls-remote --exit-code origin "${target_ref}^{}")"; then
      :
    else
      status=$?
      [[ "$status" == "2" ]] ||
        die "Could not resolve the requested tag from the public repository"
      output="$(git_safe -C "$repo_dir" ls-remote --exit-code origin "$target_ref")" ||
        die "Could not resolve the requested tag from the public repository"
    fi
  else
    output="$(git_safe -C "$repo_dir" ls-remote --exit-code origin "$target_ref")" ||
      die "Could not resolve the requested branch from the public repository"
  fi
  [[ "$output" != *$'\n'* ]] ||
    die "Remote ref resolution returned multiple unexpected results"
  ADVERTISED_COMMIT="${output%%$'\t'*}"
  [[ "$ADVERTISED_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
    die "Remote ref did not advertise an exact commit"
}

resolve_and_fetch_ref() {
  local repo_dir="$1" target_kind="" target_ref="" target_commit=""
  local tag_exists=0 branch_exists=0 short_ref="$REF"
  git_safe -C "$repo_dir" init -q --template=
  git_safe -C "$repo_dir" remote add origin "$CANONICAL_REPO"
  case "$REF" in
    refs/tags/*)
      target_kind="tag"
      target_ref="$REF"
      git_safe -C "$repo_dir" ls-remote --exit-code origin "$target_ref" >/dev/null 2>&1 ||
        die "Requested tag does not exist in the public repository"
      ;;
    refs/heads/*)
      target_kind="branch"
      target_ref="$REF"
      git_safe -C "$repo_dir" ls-remote --exit-code origin "$target_ref" >/dev/null 2>&1 ||
        die "Requested branch does not exist in the public repository"
      ;;
    refs/*)
      die "Only refs/heads/* and refs/tags/* are accepted"
      ;;
    *)
      git_safe -C "$repo_dir" ls-remote --exit-code origin "refs/tags/$short_ref" >/dev/null 2>&1 &&
        tag_exists=1
      git_safe -C "$repo_dir" ls-remote --exit-code origin "refs/heads/$short_ref" >/dev/null 2>&1 &&
        branch_exists=1
      if [[ "$tag_exists" == "1" && "$branch_exists" == "1" ]]; then
        die "Requested name is both a branch and a tag; use an explicit refs/heads/* or refs/tags/* ref"
      elif [[ "$tag_exists" == "1" ]]; then
        target_kind="tag"
        target_ref="refs/tags/$short_ref"
      elif [[ "$branch_exists" == "1" ]]; then
        target_kind="branch"
        target_ref="refs/heads/$short_ref"
      else
        die "Requested branch or tag does not exist in the public repository"
      fi
      ;;
  esac
  resolve_advertised_commit "$repo_dir" "$target_kind" "$target_ref"
  git_safe -C "$repo_dir" fetch --depth=1 origin "$target_ref"
  target_commit="$(git_safe -C "$repo_dir" rev-parse --verify 'FETCH_HEAD^{commit}')"
  [[ "$target_commit" =~ ^[0-9a-f]{40}$ ]] ||
    die "Remote ref did not resolve to an exact commit"
  [[ "$target_commit" == "$ADVERTISED_COMMIT" ]] ||
    die "Remote ref changed while it was being fetched"
  if [[ -n "$EXPECTED_COMMIT" && "$target_commit" != "$EXPECTED_COMMIT" ]]; then
    die "Resolved ref does not match the expected commit"
  fi
  git_safe -C "$repo_dir" checkout --detach "$target_commit"
  [[ "$(git_safe -C "$repo_dir" rev-parse --verify HEAD)" == "$target_commit" ]] ||
    die "Exact commit checkout verification failed"
  RESOLVED_COMMIT="$target_commit"
  [[ "$(git_safe -C "$repo_dir" config --local --get-all remote.origin.url)" == "$CANONICAL_REPO" ]] ||
    die "Staged checkout origin verification failed"
  git_status_output "$repo_dir"
  [[ -z "$GIT_STATUS_OUTPUT" ]] ||
    die "Staged checkout is unexpectedly dirty"
  ! has_gitlinks "$repo_dir" ||
    die "Public releases with Git submodules are not supported"
  log "Verified update $target_kind commit: $target_commit"
}

build_staged_release() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] fetch and build a fresh owner-only staged checkout"
    log "[dry-run] verify exact commit before atomic activation"
    return 0
  fi
  STAGE_DIR="$(mktemp -d "$APP_BASE/.skoobi-agent.stage.XXXXXXXX")"
  chmod 700 "$STAGE_DIR"
  resolve_and_fetch_ref "$STAGE_DIR"
  safe_npm --prefix "$STAGE_DIR" ci
  if [[ -f "$STAGE_DIR/agent/runner/package.json" ]]; then
    safe_npm --prefix "$STAGE_DIR/agent/runner" ci
  fi
  safe_npm --prefix "$STAGE_DIR" run build
  [[ -f "$STAGE_DIR/dist/service.js" ]] ||
    die "Build completed without dist/service.js"
  [[ -d "$STAGE_DIR/.git" && ! -L "$STAGE_DIR/.git" ]] ||
    die "Build replaced staged Git metadata"
  [[ "$(git_safe -C "$STAGE_DIR" rev-parse --verify 'HEAD^{commit}')" == "$RESOLVED_COMMIT" ]] ||
    die "Build changed the staged release commit"
  git_status_output "$STAGE_DIR"
  [[ -z "$GIT_STATUS_OUTPUT" ]] ||
    die "Build modified tracked or non-ignored staged source files"
  rm -rf "$BUILD_HOME"
  BUILD_HOME=""
}

switch_release() {
  [[ "$DRY_RUN" == "0" ]] || {
    log "[dry-run] atomically switch staged release into $APP_DIR"
    return 0
  }
  OLD_RELEASE_ROOT="$(mktemp -d "$APP_BASE/.skoobi-agent.previous.XXXXXXXX")"
  chmod 700 "$OLD_RELEASE_ROOT"
  OLD_RELEASE="$OLD_RELEASE_ROOT/release"
  mv "$APP_DIR" "$OLD_RELEASE"
  if ! mv "$STAGE_DIR" "$APP_DIR"; then
    mv "$OLD_RELEASE" "$APP_DIR"
    die "Could not activate staged release"
  fi
  STAGE_DIR=""
}

restart_service() {
  [[ "$NO_START" == "0" ]] || return 0
  case "$(detect_os)" in
    macos)
      local target
      target="gui/$(id -u)/$SERVICE_LABEL"
      if [[ "$DRY_RUN" == "1" ]]; then
        log "[dry-run] restart loaded launchd service"
      elif launchctl print "$target" >/dev/null 2>&1; then
        launchctl kickstart -k "$target"
        launchctl print "$target" >/dev/null
      else
        log "Service is not loaded; release activated without restart."
      fi
      ;;
    linux)
      if [[ "$DRY_RUN" == "1" ]]; then
        log "[dry-run] restart installed systemd user service"
      elif systemctl --user list-unit-files "$LINUX_UNIT.service" >/dev/null 2>&1; then
        systemctl --user restart "$LINUX_UNIT"
        systemctl --user is-active --quiet "$LINUX_UNIT"
      else
        log "Service is not installed; release activated without restart."
      fi
      ;;
    *) log "Unsupported OS; release activated without restart." ;;
  esac
}

rollback_release() {
  local status="$1"
  [[ "$UPDATE_SUCCEEDED" == "0" ]] || return 0
  set +e
  if [[ -n "$OLD_RELEASE" && -e "$OLD_RELEASE" ]]; then
    rm -rf "$APP_DIR"
    mv "$OLD_RELEASE" "$APP_DIR"
    OLD_RELEASE=""
    restart_service >/dev/null 2>&1 || true
    log "Previous active release restored."
  fi
  [[ -z "$STAGE_DIR" || ! -e "$STAGE_DIR" ]] || rm -rf "$STAGE_DIR"
  [[ -z "$BUILD_HOME" || ! -e "$BUILD_HOME" ]] || rm -rf "$BUILD_HOME"
  [[ -z "$GIT_HOME" || ! -e "$GIT_HOME" ]] || rm -rf "$GIT_HOME"
  if [[ -n "$OLD_RELEASE_ROOT" && -d "$OLD_RELEASE_ROOT" ]]; then
    rmdir "$OLD_RELEASE_ROOT" >/dev/null 2>&1 || true
  fi
  if [[ "$LOCK_HELD" == "1" ]]; then
    rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
    LOCK_HELD=0
  fi
  set -e
  return "$status"
}

on_exit() {
  local status="$1"
  rollback_release "$status" || true
  exit "$status"
}
trap 'on_exit $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

main() {
  [[ ! -L "$PREFIX" && ! -L "$APP_BASE" && ! -L "$APP_DIR" &&
      ! -L "$INSTANCE_ROOT" && ! -L "$INSTANCE_DIR" && ! -L "$BACKUP_DIR" &&
      ! -L "$MARKER_FILE" ]] ||
    die "Refusing to update through a symlinked managed path"
  if [[ "$DRY_RUN" == "0" ]]; then
    assert_real_git_checkout
  fi
  [[ -d "$INSTANCE_DIR" || "$DRY_RUN" == "1" ]] ||
    die "Instance not found"

  if [[ "$DRY_RUN" == "0" ]]; then
    acquire_operation_lock
    validate_origin
    if ! valid_marker; then
      [[ "$ADOPT_MANAGED" == "1" ]] ||
        die "Managed-install marker missing or invalid; use --adopt-managed only after verification"
      verify_published_commit
    fi
    ! has_gitlinks "$APP_DIR" ||
      die "Managed app contains unsupported Git submodules"
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    acquire_operation_lock
  fi

  log "Updating Skoobi app"
  log "app: $APP_DIR"
  log "instance: $INSTANCE_DIR"
  log "repository: canonical public HTTPS"
  log "ref: $REF"

  run mkdir -p "$BACKUP_DIR"
  run chmod 700 "$PREFIX" "$BACKUP_DIR" "$INSTANCE_DIR"

  local dirty=0
  if [[ "$DRY_RUN" == "0" ]]; then
    git_status_output "$APP_DIR"
    [[ -z "$GIT_STATUS_OUTPUT" ]] ||
      dirty=1
    has_owner_ignored_files && dirty=1
    has_special_files && dirty=1
  fi
  if [[ "$dirty" == "1" ]]; then
    [[ "$FORCE" == "1" ]] ||
      die "App checkout has owner changes; update refused without explicit --force"
    confirm_force
    backup_owner_changes
  elif [[ "$FORCE" == "1" ]]; then
    log "No owner changes found; forced replacement is unnecessary."
  fi

  build_staged_release
  switch_release
  write_marker
  restart_service

  UPDATE_SUCCEEDED=1
  if [[ -n "$OLD_RELEASE" && -e "$OLD_RELEASE" ]]; then
    rm -rf "$OLD_RELEASE"
    OLD_RELEASE=""
  fi
  if [[ -n "$OLD_RELEASE_ROOT" && -d "$OLD_RELEASE_ROOT" ]]; then
    rmdir "$OLD_RELEASE_ROOT"
    OLD_RELEASE_ROOT=""
  fi
  [[ -z "$GIT_HOME" || ! -e "$GIT_HOME" ]] || rm -rf "$GIT_HOME"
  GIT_HOME=""
  release_operation_lock
  log "Skoobi update complete."
}

main "$@"
