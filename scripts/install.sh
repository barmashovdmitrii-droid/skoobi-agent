#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CANONICAL_REPO="https://github.com/barmashovdmitrii-droid/skoobi-agent.git"
REF_DEFAULT="main"
EXPECTED_COMMIT_DEFAULT=""
APP_NAME="skoobi-agent"
VERSION="2.0.0-rc.1"

PREFIX="${SKOOBI_PREFIX:-$HOME/.skoobi}"
INSTANCE="default"
REPO="$CANONICAL_REPO"
REF="$REF_DEFAULT"
EXPECTED_COMMIT="$EXPECTED_COMMIT_DEFAULT"
NO_SERVICE=0
NO_START=0
YES=0
DRY_RUN=0
RECONFIGURE=0
ADOPT_MANAGED=0
MIGRATE_LEGACY_NAME=""
PRINT_SERVICE=""

STAGE_DIR=""
OLD_RELEASE=""
OLD_RELEASE_ROOT=""
CLI_CHANGED=0
CLI_BACKUP=""
CLI_MOVED_ASIDE=0
SERVICE_CHANGED=0
SERVICE_BACKUP=""
SERVICE_EXISTED=0
SERVICE_WAS_ACTIVE=0
INSTALL_SUCCEEDED=0
BUILD_HOME=""
GIT_HOME=""
STAGE_ACTIVATION_STARTED=0
LOCK_DIR=""
LOCK_HELD=0
ENV_BACKUP=""
ENV_CREATED_BY_INSTALL=0

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
  bash install.sh [options]

Download install.sh from a tagged GitHub release and verify the published
SHA-256 checksum before running it. Do not pipe a moving branch into a shell.

Options:
  --prefix <path>        Install prefix (default: ~/.skoobi)
  --instance <name>      Instance name (default: default)
  --repo <url>           Must be the canonical public HTTPS repository
  --ref <branch/tag>     Git branch or tag to install (default: main)
  --expected-commit <id> Require the resolved ref to match this 40-hex commit
  --no-service           Do not create launchd/systemd service
  --no-start             Create service but do not start it
  --yes                  Non-interactive defaults
  --reconfigure          Explicitly update an existing instance .env
  --adopt-managed        Adopt a verified old public install missing its marker
  --migrate-legacy <dir> Preserve a verified legacy app directory by basename
  --dry-run              Print planned actions without changing files
  --version              Show installer version
  --help                 Show this help

Existing instance configuration is preserved on a normal rerun. Use
--reconfigure only when you intentionally want the installer to edit it.

Security:
  The installer accepts only the canonical public HTTPS repository. It never
  reads Codex/Claude auth files, browser cookies, or token stores. Build
  subprocesses receive a minimal environment without provider or bot secrets.
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
      shift 2
      ;;
    --ref)
      REF="${2:-}"
      [[ -n "$REF" ]] || die "--ref requires a branch or tag"
      shift 2
      ;;
    --expected-commit)
      EXPECTED_COMMIT="${2:-}"
      [[ -n "$EXPECTED_COMMIT" ]] || die "--expected-commit requires a commit"
      shift 2
      ;;
    --no-service) NO_SERVICE=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    --adopt-managed) ADOPT_MANAGED=1; shift ;;
    --migrate-legacy)
      MIGRATE_LEGACY_NAME="${2:-}"
      [[ -n "$MIGRATE_LEGACY_NAME" &&
          "$MIGRATE_LEGACY_NAME" != -* ]] ||
        die "--migrate-legacy requires a directory basename"
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    --version|-V)
      printf 'skoobi-installer %s\n' "$VERSION"
      exit 0
      ;;
    --print-service)
      PRINT_SERVICE="${2:-}"
      [[ "$PRINT_SERVICE" == "macos" || "$PRINT_SERVICE" == "linux" ]] ||
        die "--print-service requires macos or linux"
      shift 2
      ;;
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
if [[ -n "$MIGRATE_LEGACY_NAME" ]]; then
  [[ "$MIGRATE_LEGACY_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
    die "Legacy directory must be a safe basename"
  [[ "$MIGRATE_LEGACY_NAME" != "$APP_NAME" &&
      "$MIGRATE_LEGACY_NAME" != *.lock ]] ||
    die "Legacy directory must be different from the managed app directory"
fi
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
[[ "$REPO" == "$CANONICAL_REPO" ]] ||
  die "Repository must be the canonical public HTTPS Skoobi repository"

PREFIX="${PREFIX/#\~/$HOME}"
[[ "$PREFIX" == /* ]] || PREFIX="$PWD/$PREFIX"
APP_BASE="$PREFIX/app"
APP_DIR="$APP_BASE/$APP_NAME"
LEGACY_APP_DIR=""
if [[ -n "$MIGRATE_LEGACY_NAME" ]]; then
  LEGACY_APP_DIR="$APP_BASE/$MIGRATE_LEGACY_NAME"
fi
INSTANCE_ROOT="$PREFIX/instances"
INSTANCE_DIR="$INSTANCE_ROOT/$INSTANCE"
BACKUP_DIR="$PREFIX/backups"
ENV_FILE="$INSTANCE_DIR/.env"
MARKER_FILE="$PREFIX/.skoobi-managed-install"
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

acquire_operation_lock() {
  LOCK_DIR="$PREFIX/.skoobi-operation.lock"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] acquire exclusive installer operation lock"
    return 0
  fi
  [[ ! -L "$PREFIX" && (! -e "$PREFIX" || -d "$PREFIX") ]] ||
    die "Install prefix must be a real directory"
  mkdir -p "$PREFIX"
  chmod 700 "$PREFIX"
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

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *) echo "unsupported" ;;
  esac
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

node_bin() {
  command -v node
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

systemd_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\%/%%}"
  value="${value//\$/\$\$}"
  printf '%s' "$value"
}

launchd_plist() {
  local node_path="$1"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$SERVICE_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_path")</string>
    <string>$(xml_escape "$APP_DIR/dist/service.js")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$INSTANCE_DIR")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>Umask</key>
  <integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$(xml_escape "$HOME")/.local/bin</string>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>SKOOBI_SERVICE_LABEL</key>
    <string>$(xml_escape "$SERVICE_LABEL")</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$INSTANCE_DIR/logs/service.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$INSTANCE_DIR/logs/service.err.log")</string>
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
ExecStart="$(systemd_escape "$node_path")" "$(systemd_escape "$APP_DIR/dist/service.js")"
WorkingDirectory="$(systemd_escape "$INSTANCE_DIR")"
Restart=always
RestartSec=5
UMask=0077
Environment="HOME=$(systemd_escape "$HOME")"
Environment="PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$(systemd_escape "$HOME")/.local/bin"
Environment="SKOOBI_SERVICE_LABEL=$(systemd_escape "$SERVICE_LABEL")"

[Install]
WantedBy=default.target
EOF
}

if [[ -n "$PRINT_SERVICE" ]]; then
  if [[ "$PRINT_SERVICE" == "macos" ]]; then
    launchd_plist "$(command -v node || printf '/usr/bin/node')"
  else
    systemd_unit "$(command -v node || printf '/usr/bin/node')"
  fi
  exit 0
fi

marker_content() {
  local app_name="$1"
  printf 'format=1\nrepository=%s\napp=%s\n' "$CANONICAL_REPO" "$app_name"
}

valid_marker_for() {
  local app_name="$1"
  [[ -f "$MARKER_FILE" && ! -L "$MARKER_FILE" ]] || return 1
  [[ "$(cat "$MARKER_FILE")" == "$(marker_content "$app_name")" ]]
}

validate_origin() {
  local app_path="$1"
  local expected_origin="${2:-$CANONICAL_REPO}"
  local origin
  origin="$(git_safe -C "$app_path" config --local --get-all remote.origin.url 2>/dev/null || true)"
  [[ "$origin" == "$expected_origin" ]] ||
    die "Managed app origin is not an allowed canonical HTTPS repository"
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
  git_safe -C "$1" ls-files --others --ignored --exclude-standard -z >"$listing" ||
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

has_any_ignored_files() {
  local _ignored listing found=1
  ensure_git_home
  listing="$(mktemp "$GIT_HOME/ignored-all.XXXXXXXX")"
  git_safe -C "$1" ls-files --others --ignored --exclude-standard -z >"$listing" ||
    die "Could not inspect ignored files in the legacy app"
  if IFS= read -r -d '' _ignored <"$listing"; then
    found=0
  fi
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

assert_git_status_clean() {
  local app_path="$1" status_output
  status_output="$(git_safe -C "$app_path" status --porcelain --untracked-files=normal)" ||
    die "Could not inspect managed app status"
  [[ -z "$status_output" ]]
}

assert_real_git_checkout() {
  local app_path="$1"
  [[ -d "$app_path" && ! -L "$app_path" ]] ||
    die "Managed app path must be a real directory"
  [[ -d "$app_path/.git" && ! -L "$app_path/.git" ]] ||
    die "Managed app .git must be a real directory"
}

verify_published_commit() {
  local app_path="$1" commit probe_dir fetched
  commit="$(git_safe -C "$app_path" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
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

assert_existing_install_safe() {
  [[ ! -L "$PREFIX" && ! -L "$APP_BASE" && ! -L "$APP_DIR" &&
      ! -L "$BACKUP_DIR" ]] ||
    die "Refusing to install through a symlinked managed path"
  if [[ -n "$LEGACY_APP_DIR" && -L "$LEGACY_APP_DIR" ]]; then
    die "Refusing to migrate a symlinked legacy app path"
  fi
  if [[ -n "$LEGACY_APP_DIR" && -e "$APP_DIR" &&
      "$LEGACY_APP_DIR" -ef "$APP_DIR" ]]; then
    die "Legacy directory must be different from the managed app directory"
  fi

  if [[ -e "$APP_DIR" ]]; then
    assert_real_git_checkout "$APP_DIR"
    validate_origin "$APP_DIR"
    if ! valid_marker_for "$APP_NAME"; then
      [[ "$ADOPT_MANAGED" == "1" ]] ||
        die "Managed-install marker missing or invalid; use --adopt-managed only after verification"
      verify_published_commit "$APP_DIR"
    fi
    assert_git_status_clean "$APP_DIR" ||
      die "App checkout has local changes; use the updater to preserve them"
    ! has_owner_ignored_files "$APP_DIR" ||
      die "App checkout contains ignored owner files; preserve them before reinstalling"
    ! has_gitlinks "$APP_DIR" ||
      die "Managed app contains unsupported Git submodules"
  fi
  if [[ -n "$LEGACY_APP_DIR" ]]; then
    [[ -e "$LEGACY_APP_DIR" ]] ||
      die "Requested legacy app directory was not found"
    assert_real_git_checkout "$LEGACY_APP_DIR"
    local legacy_origin
    legacy_origin="$(git_safe -C "$LEGACY_APP_DIR" config --local --get-all remote.origin.url 2>/dev/null || true)"
    [[ "$legacy_origin" == "$CANONICAL_REPO" ]] ||
      die "Legacy app origin is not an allowed canonical HTTPS repository"
    assert_git_status_clean "$LEGACY_APP_DIR" ||
      die "Legacy app checkout has local changes; preserve them before migration"
    ! has_any_ignored_files "$LEGACY_APP_DIR" ||
      die "Legacy app checkout contains ignored files; preserve them before migration"
    ! has_gitlinks "$LEGACY_APP_DIR" ||
      die "Legacy app checkout contains unsupported Git submodules"
    log "Verified legacy install will be preserved while the new app directory is installed."
  fi
}

check_requirements() {
  if [[ "${SKOOBI_INSTALLER_SKIP_REQUIREMENTS:-}" == "1" ]]; then
    log "Skipping requirement checks (test mode)"
    return 0
  fi
  local os_name major
  os_name="$(detect_os)"
  [[ "$os_name" != "unsupported" ]] || die "Only macOS and Linux are supported"
  require_command curl
  require_command git
  require_command npm
  require_command node
  require_command sqlite3
  major="$(node_major)"
  [[ "$major" -ge 22 ]] ||
    die "Node.js >= 22 is required"
  if [[ "$NO_SERVICE" == "0" ]]; then
    if [[ "$os_name" == "macos" ]]; then
      require_command launchctl
    else
      require_command systemctl
    fi
  fi
}

preflight_service_path() {
  [[ "$NO_SERVICE" == "0" ]] || return 0
  local service_file service_dir relative_dir
  [[ -d "$HOME" && ! -L "$HOME" ]] ||
    die "HOME must be a real directory"
  if [[ "$(detect_os)" == "macos" ]]; then
    service_file="$MACOS_PLIST"
    relative_dir="Library/LaunchAgents"
  else
    service_file="$LINUX_UNIT"
    relative_dir=".config/systemd/user"
  fi
  assert_home_directory_chain "$relative_dir"
  service_dir="$(dirname "$service_file")"
  [[ ! -L "$service_dir" ]] ||
    die "Refusing to use a symlinked service directory"
  [[ ! -L "$service_file" ]] ||
    die "Refusing to replace a symlinked service file"
  [[ ! -e "$service_file" || -f "$service_file" ]] ||
    die "Refusing to replace a non-regular service file"
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
  local repo_dir="$1"
  local target_kind="" target_ref="" target_commit=""
  local tag_exists=0 branch_exists=0 short_ref="$REF"
  git_safe -C "$repo_dir" init -q --template=
  git_safe -C "$repo_dir" remote add origin "$CANONICAL_REPO"

  case "$REF" in
    refs/tags/*)
      short_ref="${REF#refs/tags/}"
      target_kind="tag"
      target_ref="$REF"
      git_safe -C "$repo_dir" ls-remote --exit-code origin "$target_ref" >/dev/null 2>&1 ||
        die "Requested tag does not exist in the public repository"
      ;;
    refs/heads/*)
      short_ref="${REF#refs/heads/}"
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
    die "Resolved ref does not match the release asset's expected commit"
  fi
  git_safe -C "$repo_dir" checkout --detach "$target_commit"
  [[ "$(git_safe -C "$repo_dir" rev-parse --verify HEAD)" == "$target_commit" ]] ||
    die "Exact commit checkout verification failed"
  RESOLVED_COMMIT="$target_commit"
  [[ "$(git_safe -C "$repo_dir" config --local --get-all remote.origin.url)" == "$CANONICAL_REPO" ]] ||
    die "Staged checkout origin verification failed"
  assert_git_status_clean "$repo_dir" ||
    die "Staged checkout is unexpectedly dirty"
  ! has_gitlinks "$repo_dir" ||
    die "Public releases with Git submodules are not supported"
  log "Verified $target_kind commit: $target_commit"
}

build_staged_release() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] create owner-only staging checkout"
    log "[dry-run] fetch $REF from the canonical public repository"
    log "[dry-run] verify exact commit, npm ci, runner npm ci, and build in staging"
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
  assert_real_git_checkout "$STAGE_DIR"
  [[ "$(git_safe -C "$STAGE_DIR" rev-parse --verify 'HEAD^{commit}')" == "$RESOLVED_COMMIT" ]] ||
    die "Build changed the staged release commit"
  assert_git_status_clean "$STAGE_DIR" ||
    die "Build modified tracked or non-ignored staged source files"
  rm -rf "$BUILD_HOME"
  BUILD_HOME=""
}

switch_release() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] atomically switch the verified staged release into $APP_DIR"
    return 0
  fi
  if [[ -e "$APP_DIR" ]]; then
    OLD_RELEASE_ROOT="$(mktemp -d "$APP_BASE/.skoobi-agent.previous.XXXXXXXX")"
    chmod 700 "$OLD_RELEASE_ROOT"
    OLD_RELEASE="$OLD_RELEASE_ROOT/release"
    mv "$APP_DIR" "$OLD_RELEASE"
  fi
  STAGE_ACTIVATION_STARTED=1
  if ! mv "$STAGE_DIR" "$APP_DIR"; then
    [[ -z "$OLD_RELEASE" || ! -e "$OLD_RELEASE" ]] ||
      mv "$OLD_RELEASE" "$APP_DIR"
    STAGE_ACTIVATION_STARTED=0
    die "Could not activate the staged release"
  fi
  STAGE_DIR=""
}

env_quote() {
  local value="$1"
  case "$value" in
    *$'\n'*|*$'\r'*) die "Configuration values must not contain newlines" ;;
  esac
  printf '"%s"' "$value"
}

set_env_key() {
  local key="$1" value="$2" quoted tmp line found=0
  quoted="$(env_quote "$value")"
  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ "$key" == *TOKEN* || "$key" == *KEY* || "$key" == *SECRET* ||
        "$key" == *URL* ]]; then
      log "[dry-run] set $key=<redacted> in $ENV_FILE"
    else
      log "[dry-run] set $key=$quoted in $ENV_FILE"
    fi
    return
  fi
  tmp="$(mktemp "$ENV_FILE.tmp.XXXXXX")"
  if [[ -f "$ENV_FILE" ]] &&
    grep -Eq "^[[:space:]]*${key}=" "$ENV_FILE"; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*${key}= ]]; then
        if [[ "$found" == "0" ]]; then
          printf '%s=%s\n' "$key" "$quoted" >>"$tmp"
          found=1
        fi
      else
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$ENV_FILE"
    if [[ "$found" == "0" ]]; then
      printf '%s=%s\n' "$key" "$quoted" >>"$tmp"
    fi
  else
    [[ ! -f "$ENV_FILE" ]] || cp "$ENV_FILE" "$tmp"
    printf '\n%s=%s\n' "$key" "$quoted" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

env_has_key() {
  [[ -f "$ENV_FILE" ]] && grep -Eq "^[[:space:]]*$1=" "$ENV_FILE"
}

assert_instance_path_types() {
  local path
  for path in "$INSTANCE_ROOT" "$INSTANCE_DIR" "$INSTANCE_DIR/store" \
    "$INSTANCE_DIR/groups" "$INSTANCE_DIR/logs" "$INSTANCE_DIR/data" \
    "$BACKUP_DIR"; do
    [[ ! -L "$path" ]] ||
      die "Refusing to configure an instance through a symlinked managed path"
    [[ ! -e "$path" || -d "$path" ]] ||
      die "Managed instance directory path is not a directory"
  done
  [[ ! -L "$ENV_FILE" ]] ||
    die "Refusing to configure a symlinked instance .env"
  [[ ! -e "$ENV_FILE" || -f "$ENV_FILE" ]] ||
    die "Instance .env must be a regular file"
}

prepare_instance() {
  assert_instance_path_types
  run mkdir -p "$INSTANCE_DIR/store" "$INSTANCE_DIR/groups" \
    "$INSTANCE_DIR/logs" "$INSTANCE_DIR/data" "$BACKUP_DIR"
  assert_instance_path_types
  run chmod 700 "$PREFIX" "$INSTANCE_ROOT" "$INSTANCE_DIR" \
    "$INSTANCE_DIR/store" "$INSTANCE_DIR/groups" "$INSTANCE_DIR/logs" \
    "$INSTANCE_DIR/data" "$BACKUP_DIR"

  if [[ -f "$ENV_FILE" ]]; then
    if [[ "$RECONFIGURE" == "0" ]]; then
      log "Existing instance configuration preserved unchanged."
      return 1
    fi
    local backup
    if [[ "$DRY_RUN" == "1" ]]; then
      log "[dry-run] back up existing .env before explicit reconfiguration"
      return 0
    fi
    backup="$(mktemp "$BACKUP_DIR/${INSTANCE}.env.XXXXXXXX.bak")"
    ENV_BACKUP="$backup"
    log "Backing up existing .env before explicit reconfiguration: $backup"
    cp "$ENV_FILE" "$backup"
    chmod 600 "$backup"
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] create owner-only $ENV_FILE"
  elif [[ -f "$APP_DIR/.env.example" ]]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ENV_CREATED_BY_INSTALL=1
  else
    printf 'RUNTIME=sandbox\nASSISTANT_NAME=Skoobi\nSKOOBI_TELEGRAM_GUEST_LIVE_ENABLED=false\n' >"$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ENV_CREATED_BY_INSTALL=1
  fi
  return 0
}

configure_env() {
  local assistant="${SKOOBI_ASSISTANT_NAME:-}"
  if [[ -z "$assistant" && "$YES" == "0" ]]; then
    read -r -p "Assistant name [Skoobi]: " assistant || true
  fi
  assistant="${assistant:-Skoobi}"
  set_env_key ASSISTANT_NAME "$assistant"
  set_env_key RUNTIME "sandbox"
  set_env_key SKOOBI_SERVICE_LABEL "$SERVICE_LABEL"
  set_env_key SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED "false"
  set_env_key SKOOBI_LIVE_CANARY_ENABLED "false"

  local token="${SKOOBI_TELEGRAM_BOT_TOKEN:-}"
  if [[ -z "$token" && "$YES" == "0" ]] && ! env_has_key TELEGRAM_BOT_TOKEN; then
    read -r -s -p "Telegram bot token (input hidden, leave blank to skip): " token || true
    printf '\n'
  fi
  [[ -z "$token" ]] || set_env_key TELEGRAM_BOT_TOKEN "$token"

  local provider="${SKOOBI_INSTALL_PROVIDER:-codex}"
  case "$provider" in
    codex)
      set_env_key SKOOBI_MODEL_GATEWAY_TYPE "codex_subscription_cli"
      set_env_key SKOOBI_CODEX_SUBSCRIPTION_ENABLED "true"
      ;;
    claude)
      set_env_key SKOOBI_MODEL_GATEWAY_TYPE "disabled"
      set_env_key SKOOBI_CODEX_SUBSCRIPTION_ENABLED "false"
      ;;
    openai)
      set_env_key SKOOBI_MODEL_GATEWAY_TYPE "openai_compatible"
      set_env_key SKOOBI_MODEL_GATEWAY_BASE_URL \
        "${SKOOBI_MODEL_GATEWAY_BASE_URL:-https://api.openai.com/v1}"
      [[ -z "${SKOOBI_MODEL_GATEWAY_KEY:-}" ]] ||
        set_env_key SKOOBI_MODEL_GATEWAY_KEY "$SKOOBI_MODEL_GATEWAY_KEY"
      ;;
    *) die "Unknown provider selection" ;;
  esac
}

confirm_cli_replace() {
  [[ "$YES" == "1" || "$DRY_RUN" == "1" ]] && return 0
  local answer=""
  read -r -p "Back up and replace the existing skoobi CLI path? [y/N]: " answer || true
  [[ "$answer" =~ ^(y|Y|yes|YES)$ ]]
}

install_cli_symlink() {
  [[ -d "$HOME" && ! -L "$HOME" ]] ||
    die "HOME must be a real directory"
  assert_home_directory_chain ".local/bin"
  if [[ ! -d "$CLI_LINK_DIR" ]]; then
    if [[ "$YES" == "1" || "$DRY_RUN" == "1" ]]; then
      run mkdir -p "$CLI_LINK_DIR"
    else
      log "CLI directory does not exist; skipping optional CLI link."
      return 0
    fi
  fi
  assert_home_directory_chain ".local/bin"
  [[ ! -L "$CLI_LINK_DIR" ]] || die "Refusing to use a symlinked CLI directory"
  if [[ -L "$CLI_LINK" && "$(readlink "$CLI_LINK" 2>/dev/null || true)" == "$CLI_TARGET" ]]; then
    log "CLI symlink already installed."
    return 0
  fi
  if [[ -e "$CLI_LINK" || -L "$CLI_LINK" ]]; then
    confirm_cli_replace || {
      log "Existing CLI path preserved."
      return 0
    }
    if [[ "$DRY_RUN" == "1" ]]; then
      log "[dry-run] move existing CLI path into an owner-only backup"
    else
      local cli_backup_root
      cli_backup_root="$(mktemp -d "$BACKUP_DIR/cli-backup-XXXXXXXX")"
      chmod 700 "$cli_backup_root"
      CLI_BACKUP="$cli_backup_root/skoobi"
      mv "$CLI_LINK" "$CLI_BACKUP"
      CLI_MOVED_ASIDE=1
    fi
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    run ln -s "$CLI_TARGET" "$CLI_LINK"
  else
    ln -s "$CLI_TARGET" "$CLI_LINK"
    CLI_CHANGED=1
  fi
  log "CLI symlink: $CLI_LINK -> $CLI_TARGET"
}

atomic_write_service() {
  local file="$1" content="$2" dir tmp
  dir="$(dirname "$file")"
  preflight_service_path
  run mkdir -p "$dir"
  [[ "$DRY_RUN" == "1" ]] && {
    log "[dry-run] atomically write regular service file $file"
    return 0
  }
  preflight_service_path
  if [[ -e "$file" ]]; then
    SERVICE_EXISTED=1
    SERVICE_BACKUP="$(mktemp "$BACKUP_DIR/service.$(basename "$file").XXXXXXXX")"
    cp "$file" "$SERVICE_BACKUP"
    chmod 600 "$SERVICE_BACKUP"
  fi
  tmp="$(mktemp "$dir/.skoobi-service.XXXXXXXX")"
  printf '%s' "$content" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
  SERVICE_CHANGED=1
}

stop_existing_service() {
  [[ "$NO_SERVICE" == "0" && "$DRY_RUN" == "0" ]] || return 0
  if [[ "$(detect_os)" == "macos" ]]; then
    local target
    target="gui/$(id -u)/$SERVICE_LABEL"
    if launchctl print "$target" >/dev/null 2>&1; then
      SERVICE_WAS_ACTIVE=1
      [[ -f "$MACOS_PLIST" ]] ||
        die "Active launchd service has no regular managed plist"
    fi
    launchctl disable "$target" >/dev/null 2>&1 || true
    launchctl bootout "$target" >/dev/null 2>&1 || true
    ! launchctl print "$target" >/dev/null 2>&1 ||
      die "Existing launchd service did not stop"
  else
    local status
    if systemctl --user is-active --quiet "skoobi-$INSTANCE"; then
      status=0
    else
      status=$?
    fi
    case "$status" in
      0)
        SERVICE_WAS_ACTIVE=1
        [[ -f "$LINUX_UNIT" ]] ||
          die "Active systemd service has no regular managed unit"
        ;;
      3) ;;
      4)
        [[ -e "$LINUX_UNIT" ]] ||
          return 0
        ;;
      *) die "Could not determine whether the existing systemd service is active" ;;
    esac
    systemctl --user disable --now "skoobi-$INSTANCE" >/dev/null 2>&1 ||
      die "Could not stop and disable the existing systemd service"
    if systemctl --user is-active --quiet "skoobi-$INSTANCE"; then
      status=0
    else
      status=$?
    fi
    case "$status" in
      3|4) ;;
      0) die "Existing systemd service did not stop" ;;
      *) die "Could not prove that the existing systemd service stopped" ;;
    esac
  fi
}

install_service() {
  [[ "$NO_SERVICE" == "0" ]] || return 0
  local os_name node_path
  os_name="$(detect_os)"
  node_path="$(node_bin)"
  case "$node_path" in
    *$'\n'*|*$'\r'*) die "Node executable path must not contain newlines" ;;
  esac
  [[ "$NO_START" == "1" ]] || stop_existing_service
  if [[ "$os_name" == "macos" ]]; then
    atomic_write_service "$MACOS_PLIST" "$(launchd_plist "$node_path")"
    if [[ "$NO_START" == "0" && "$DRY_RUN" == "0" ]]; then
      local target
      target="gui/$(id -u)/$SERVICE_LABEL"
      launchctl enable "$target"
      launchctl bootstrap "gui/$(id -u)" "$MACOS_PLIST"
      launchctl kickstart -k "$target"
      launchctl print "$target" >/dev/null
    fi
  else
    atomic_write_service "$LINUX_UNIT" "$(systemd_unit "$node_path")"
    if [[ "$NO_START" == "0" && "$DRY_RUN" == "0" ]]; then
      systemctl --user daemon-reload
      systemctl --user enable --now "skoobi-$INSTANCE"
      systemctl --user is-active --quiet "skoobi-$INSTANCE"
    fi
  fi
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
  marker_content "$APP_NAME" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$MARKER_FILE"
}

rollback_transaction() {
  local status="$1"
  [[ "$INSTALL_SUCCEEDED" == "0" ]] || return 0
  set +e
  if [[ "$SERVICE_CHANGED" == "1" ]]; then
    if [[ "$SERVICE_EXISTED" == "1" && -f "$SERVICE_BACKUP" ]]; then
      if [[ "$(detect_os)" == "macos" ]]; then
        mv -f "$SERVICE_BACKUP" "$MACOS_PLIST"
      else
        mv -f "$SERVICE_BACKUP" "$LINUX_UNIT"
      fi
    else
      if [[ "$(detect_os)" == "macos" ]]; then
        rm -f "$MACOS_PLIST"
      else
        rm -f "$LINUX_UNIT"
      fi
    fi
  fi
  if [[ "$SERVICE_WAS_ACTIVE" == "1" ]]; then
    if [[ "$(detect_os)" == "macos" ]]; then
      local target
      target="gui/$(id -u)/$SERVICE_LABEL"
      launchctl enable "$target" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$MACOS_PLIST" >/dev/null 2>&1 || true
      launchctl kickstart -k "$target" >/dev/null 2>&1 || true
    else
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      systemctl --user enable --now "skoobi-$INSTANCE" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$CLI_CHANGED" == "1" ]]; then
    rm -f "$CLI_LINK"
  fi
  if [[ "$CLI_MOVED_ASIDE" == "1" &&
      -n "$CLI_BACKUP" && (-e "$CLI_BACKUP" || -L "$CLI_BACKUP") ]]; then
    if [[ ! -e "$CLI_LINK" && ! -L "$CLI_LINK" ]]; then
      mv "$CLI_BACKUP" "$CLI_LINK"
      CLI_MOVED_ASIDE=0
    fi
  fi
  if [[ -n "$ENV_BACKUP" && -f "$ENV_BACKUP" ]]; then
    rm -f "$ENV_FILE"
    cp "$ENV_BACKUP" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  elif [[ "$ENV_CREATED_BY_INSTALL" == "1" ]]; then
    rm -f "$ENV_FILE"
  fi
  if [[ -n "$OLD_RELEASE" && -e "$OLD_RELEASE" ]]; then
    rm -rf "$APP_DIR"
    mv "$OLD_RELEASE" "$APP_DIR"
  elif [[ "$STAGE_ACTIVATION_STARTED" == "1" && -e "$APP_DIR" ]]; then
    rm -rf "$APP_DIR"
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
  rollback_transaction "$status" || true
  exit "$status"
}
trap 'on_exit $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

main() {
  log "Skoobi installer"
  log "prefix: $PREFIX"
  log "app: $APP_DIR"
  log "instance: $INSTANCE_DIR"
  log "repository: canonical public HTTPS"
  log "ref: $REF"
  [[ "$DRY_RUN" == "0" ]] || log "mode: dry-run"

  check_requirements
  preflight_service_path
  acquire_operation_lock
  assert_existing_install_safe
  run mkdir -p "$APP_BASE" "$BACKUP_DIR"
  run chmod 700 "$PREFIX" "$APP_BASE" "$BACKUP_DIR"
  build_staged_release
  switch_release
  if prepare_instance; then
    configure_env
  fi
  install_cli_symlink
  install_service
  write_marker

  INSTALL_SUCCEEDED=1
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
  log "Skoobi install complete."
  log "App: $APP_DIR"
  log "Instance data: $INSTANCE_DIR"
  log "Existing configuration is preserved unless --reconfigure is explicit."
}

main "$@"
