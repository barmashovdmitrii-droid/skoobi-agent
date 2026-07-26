#!/usr/bin/env bash

# Shared lifecycle-operation lock for update.sh and uninstall.sh.
# The caller must provide PREFIX, DRY_RUN, log(), and die().

LOCK_DIR="${LOCK_DIR:-}"
LOCK_HELD="${LOCK_HELD:-0}"
LOCK_TOKEN="${LOCK_TOKEN:-}"
LOCK_IDENTITY="${LOCK_IDENTITY:-}"
LOCK_OWNER_IDENTITY="${LOCK_OWNER_IDENTITY:-}"
LOCK_OWNER_SNAPSHOT="${LOCK_OWNER_SNAPSHOT:-}"

lock_host_os() {
  if [[ -x /usr/bin/uname ]]; then
    /usr/bin/uname -s
  elif [[ -x /bin/uname ]]; then
    /bin/uname -s
  else
    return 1
  fi
}

lock_path_identity() {
  case "$(lock_host_os)" in
    Darwin) stat -f '%d:%i' "$1" 2>/dev/null ;;
    Linux) stat -c '%d:%i' "$1" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

lock_path_uid() {
  case "$(lock_host_os)" in
    Darwin) stat -f '%u' "$1" 2>/dev/null ;;
    Linux) stat -c '%u' "$1" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

lock_path_mode() {
  case "$(lock_host_os)" in
    Darwin) stat -f '%Lp' "$1" 2>/dev/null ;;
    Linux) stat -c '%a' "$1" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

lock_path_links() {
  case "$(lock_host_os)" in
    Darwin) stat -f '%l' "$1" 2>/dev/null ;;
    Linux) stat -c '%h' "$1" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

lock_private_directory() {
  local path="$1" uid="" mode=""
  [[ -d "$path" && ! -L "$path" ]] || return 1
  uid="$(lock_path_uid "$path" || true)"
  mode="$(lock_path_mode "$path" || true)"
  [[ "$uid" == "$(id -u)" && "$mode" == "700" ]]
}

lock_boot_id() {
  local value="" sec="" usec=""
  if [[ -r /proc/sys/kernel/random/boot_id ]]; then
    IFS= read -r value </proc/sys/kernel/random/boot_id || true
    if [[ "$value" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
      printf 'linux:%s' "$value"
      return 0
    fi
  elif [[ -x /usr/sbin/sysctl ]]; then
    value="$(LC_ALL=C /usr/sbin/sysctl -n kern.boottime 2>/dev/null || true)"
    sec="${value#*sec = }"
    usec="${value#*usec = }"
    if [[ "$sec" != "$value" && "$usec" != "$value" ]]; then
      sec="${sec%%,*}"
      usec="${usec%% *}"
      if [[ "$sec" =~ ^[0-9]+$ && "$usec" =~ ^[0-9]+$ ]]; then
        printf 'darwin:%s:%s' "$sec" "$usec"
        return 0
      fi
    fi
  fi
  printf 'unknown'
}

lock_process_start_id() {
  local pid="$1" record="" rest="" value=""
  local uid="" weekday="" month="" day="" clock="" year="" extra=""
  local -a fields
  if [[ -r "/proc/$pid/stat" ]]; then
    IFS= read -r record <"/proc/$pid/stat" || return 1
    rest="${record##*) }"
    read -r -a fields <<<"$rest"
    [[ ${#fields[@]} -ge 20 && "${fields[19]}" =~ ^[0-9]+$ ]] ||
      return 1
    printf 'linux:%s' "${fields[19]}"
    return 0
  fi
  value="$(LC_ALL=C TZ=UTC /bin/ps -p "$pid" -o uid= -o lstart= 2>/dev/null || true)"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
    return 1
  read -r uid weekday month day clock year extra <<<"$value"
  [[ "$uid" =~ ^(0|[1-9][0-9]*)$ &&
      "$weekday" =~ ^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$ &&
      "$month" =~ ^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$ &&
      "$day" =~ ^([1-9]|[12][0-9]|3[01])$ &&
      "$clock" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$ &&
      "$year" =~ ^[0-9]{4}$ && -z "$extra" ]] || return 1
  printf 'darwin:%s:%s:%s:%s:%s:%s' \
    "$uid" "$weekday" "$month" "$day" "$clock" "$year"
}

lock_parse_owner() {
  local file="$1" line="" value="" size="" uid="" mode="" links=""
  local identity_before="" identity_after="" checksum_before=""
  local checksum_after="" hex=""
  local line_number=0
  LOCK_META_FORMAT=""
  LOCK_META_TOKEN=""
  LOCK_META_PID=""
  LOCK_META_UID=""
  LOCK_META_BOOT_ID=""
  LOCK_META_START_ID=""
  LOCK_META_OPERATION=""
  LOCK_META_CREATED_AT=""
  [[ -f "$file" && ! -L "$file" ]] || return 1
  uid="$(lock_path_uid "$file" || true)"
  mode="$(lock_path_mode "$file" || true)"
  links="$(lock_path_links "$file" || true)"
  [[ "$uid" == "$(id -u)" && "$mode" == "600" && "$links" == "1" ]] ||
    return 1
  size="$(wc -c <"$file" | tr -d '[:space:]')"
  [[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 && "$size" -le 4096 ]] ||
    return 1
  identity_before="$(lock_path_identity "$file" || true)"
  checksum_before="$(lock_file_checksum "$file" || true)"
  hex="$(lock_file_hex "$file" || true)"
  [[ -n "$identity_before" && -n "$checksum_before" && -n "$hex" ]] ||
    return 1
  [[ ! "$hex" =~ (^|[[:space:]])00([[:space:]]|$) ]] || return 1
  [[ "$(tail -c 1 "$file" | wc -l | tr -d '[:space:]')" == "1" ]] ||
    return 1
  while IFS= read -r line; do
    line_number=$((line_number + 1))
    case "$line_number" in
      1) [[ "$line" == "format=1" ]] || return 1; LOCK_META_FORMAT=1 ;;
      2) LOCK_META_TOKEN="${line#token=}"; [[ "$line" == token=* ]] || return 1 ;;
      3) LOCK_META_PID="${line#pid=}"; [[ "$line" == pid=* ]] || return 1 ;;
      4) LOCK_META_UID="${line#uid=}"; [[ "$line" == uid=* ]] || return 1 ;;
      5) LOCK_META_BOOT_ID="${line#boot_id=}"; [[ "$line" == boot_id=* ]] || return 1 ;;
      6) LOCK_META_START_ID="${line#start_id=}"; [[ "$line" == start_id=* ]] || return 1 ;;
      7) LOCK_META_OPERATION="${line#operation=}"; [[ "$line" == operation=* ]] || return 1 ;;
      8) LOCK_META_CREATED_AT="${line#created_at=}"; [[ "$line" == created_at=* ]] || return 1 ;;
      *) return 1 ;;
    esac
  done <"$file"
  [[ "$line_number" == "8" &&
      ${#LOCK_META_TOKEN} -ge 32 && ${#LOCK_META_TOKEN} -le 256 &&
      "$LOCK_META_TOKEN" =~ ^[A-Za-z0-9_-]+$ &&
      "$LOCK_META_PID" =~ ^[1-9][0-9]*$ &&
      "$LOCK_META_UID" =~ ^(0|[1-9][0-9]*)$ &&
      "$LOCK_META_BOOT_ID" =~ ^(linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|darwin:[0-9]+:[0-9]+)$ &&
      "$LOCK_META_START_ID" =~ ^(linux:[0-9]+|darwin:(0|[1-9][0-9]*):(Sun|Mon|Tue|Wed|Thu|Fri|Sat):(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec):([1-9]|[12][0-9]|3[01]):([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]:[0-9]{4})$ &&
      "$LOCK_META_OPERATION" =~ ^[a-z][a-z0-9_-]{0,31}$ &&
      "$LOCK_META_CREATED_AT" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  if [[ "$LOCK_META_BOOT_ID" == linux:* ]]; then
    [[ "$LOCK_META_START_ID" == linux:* ]] || return 1
  else
    [[ "$LOCK_META_START_ID" == "darwin:$LOCK_META_UID:"* ]] || return 1
  fi
  identity_after="$(lock_path_identity "$file" || true)"
  checksum_after="$(lock_file_checksum "$file" || true)"
  [[ "$identity_after" == "$identity_before" &&
      "$checksum_after" == "$checksum_before" ]]
}

# Return 0 for active, 3 for provably stale, and 1 for unknown.
lock_owner_state() {
  local file="$1" current_boot="" current_start="" live_uid=""
  lock_parse_owner "$file" || return 1
  [[ "$LOCK_META_UID" == "$(id -u)" ]] || return 1
  current_boot="$(lock_boot_id)"
  [[ "$current_boot" != "unknown" ]] || return 1
  [[ "$LOCK_META_BOOT_ID" == "$current_boot" ]] || return 3
  live_uid="$(/bin/ps -o uid= -p "$LOCK_META_PID" 2>/dev/null || true)"
  live_uid="${live_uid#"${live_uid%%[![:space:]]*}"}"
  live_uid="${live_uid%"${live_uid##*[![:space:]]}"}"
  [[ -n "$live_uid" ]] || return 3
  [[ "$live_uid" =~ ^(0|[1-9][0-9]*)$ &&
      "$live_uid" == "$LOCK_META_UID" ]] || return 1
  current_start="$(lock_process_start_id "$LOCK_META_PID" || true)"
  [[ -n "$current_start" ]] || return 1
  [[ "$current_start" == "$LOCK_META_START_ID" ]] && return 0
  return 3
}

lock_directory_has_only() {
  local allowed_reclaim="$1" entry="" name=""
  for entry in "$LOCK_DIR"/* "$LOCK_DIR"/.[!.]* "$LOCK_DIR"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name="${entry##*/}"
    [[ "$name" == "owner" ]] && continue
    if [[ "$allowed_reclaim" == "1" && "$name" == "reclaim" &&
        -d "$entry" && ! -L "$entry" ]]; then
      continue
    fi
    return 1
  done
  return 0
}

lock_directory_is_empty() {
  local path="$1" entry=""
  for entry in "$path"/* "$path"/.[!.]* "$path"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] && return 1
  done
  return 0
}

lock_file_checksum() {
  [[ -x /usr/bin/cksum ]] || return 1
  LC_ALL=C /usr/bin/cksum <"$1" 2>/dev/null
}

lock_file_hex() {
  [[ -x /usr/bin/od ]] || return 1
  LC_ALL=C /usr/bin/od -An -v -tx1 "$1" 2>/dev/null
}

publish_operation_lock_owner() {
  local operation="$1" owner="$LOCK_DIR/owner" tmp="" boot="" start=""
  local uid="" created=""
  [[ "$operation" =~ ^(update|uninstall)$ ]] || return 1
  tmp="$(mktemp "$LOCK_DIR/.owner.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")" ||
    return 1
  LOCK_TOKEN="${tmp##*.owner.}"
  [[ ${#LOCK_TOKEN} -ge 32 && ${#LOCK_TOKEN} -le 256 &&
      "$LOCK_TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] || {
    rm -f "$tmp" >/dev/null 2>&1 || true
    return 1
  }
  boot="$(lock_boot_id)"
  start="$(lock_process_start_id "$$" || true)"
  [[ "$boot" != "unknown" && -n "$start" ]] || {
    rm -f "$tmp" >/dev/null 2>&1 || true
    return 1
  }
  uid="$(id -u)"
  created="$(date +%s)"
  if ! printf \
      'format=1\ntoken=%s\npid=%s\nuid=%s\nboot_id=%s\nstart_id=%s\noperation=%s\ncreated_at=%s\n' \
      "$LOCK_TOKEN" "$$" "$uid" "$boot" "$start" "$operation" "$created" \
      >"$tmp" ||
      ! chmod 600 "$tmp" ||
      ! /bin/mv -f "$tmp" "$owner"; then
    rm -f "$tmp" >/dev/null 2>&1 || true
    return 1
  fi
  LOCK_OWNER_SNAPSHOT="$(cat "$owner")" || return 1
  LOCK_IDENTITY="$(lock_path_identity "$LOCK_DIR")" || return 1
  LOCK_OWNER_IDENTITY="$(lock_path_identity "$owner")" || return 1
  lock_private_directory "$LOCK_DIR" || return 1
  lock_directory_has_only 0 || return 1
  lock_parse_owner "$owner" || return 1
  [[ "$LOCK_META_TOKEN" == "$LOCK_TOKEN" && "$LOCK_META_PID" == "$$" &&
      "$LOCK_META_OPERATION" == "$operation" ]]
}

reclaim_stale_operation_lock() {
  local expected_identity="$1" expected_owner_identity="$2"
  local expected_owner="$3" owner="$LOCK_DIR/owner"
  local current_identity="" current_owner_identity="" current_owner=""
  local reclaim_identity="" status=0
  mkdir "$LOCK_DIR/reclaim" 2>/dev/null ||
    die "Another process is already recovering the Skoobi operation lock: $LOCK_DIR"
  chmod 700 "$LOCK_DIR/reclaim" || {
    rmdir "$LOCK_DIR/reclaim" >/dev/null 2>&1 || true
    die "Could not secure the Skoobi lock recovery gate: $LOCK_DIR"
  }
  reclaim_identity="$(lock_path_identity "$LOCK_DIR/reclaim" || true)"
  current_identity="$(lock_path_identity "$LOCK_DIR" || true)"
  current_owner_identity="$(lock_path_identity "$owner" || true)"
  current_owner="$(cat "$owner" 2>/dev/null || true)"
  if [[ -z "$reclaim_identity" ||
      "$current_identity" != "$expected_identity" ||
      "$current_owner_identity" != "$expected_owner_identity" ||
      "$current_owner" != "$expected_owner" ]] ||
      ! lock_private_directory "$LOCK_DIR/reclaim" ||
      ! lock_directory_is_empty "$LOCK_DIR/reclaim" ||
      ! lock_directory_has_only 1; then
    rmdir "$LOCK_DIR/reclaim" >/dev/null 2>&1 || true
    die "Skoobi operation lock changed during recovery: $LOCK_DIR"
  fi
  if lock_owner_state "$owner"; then
    status=0
  else
    status=$?
  fi
  current_identity="$(lock_path_identity "$LOCK_DIR" || true)"
  current_owner_identity="$(lock_path_identity "$owner" || true)"
  current_owner="$(cat "$owner" 2>/dev/null || true)"
  if [[ "$status" != "3" ||
      "$current_identity" != "$expected_identity" ||
      "$current_owner_identity" != "$expected_owner_identity" ||
      "$current_owner" != "$expected_owner" ||
      "$(lock_path_identity "$LOCK_DIR/reclaim" || true)" != "$reclaim_identity" ]] ||
      ! lock_directory_is_empty "$LOCK_DIR/reclaim" ||
      ! lock_directory_has_only 1; then
    rmdir "$LOCK_DIR/reclaim" >/dev/null 2>&1 || true
    die "Skoobi operation lock could not be proven stale: $LOCK_DIR"
  fi
  rm -f "$owner" ||
    die "Could not remove stale Skoobi lock metadata: $LOCK_DIR"
  [[ "$(lock_path_identity "$LOCK_DIR/reclaim" || true)" == "$reclaim_identity" ]] &&
    lock_directory_is_empty "$LOCK_DIR/reclaim" &&
    rmdir "$LOCK_DIR/reclaim" ||
    die "Could not release stale Skoobi lock recovery gate: $LOCK_DIR"
  [[ "$(lock_path_identity "$LOCK_DIR" || true)" == "$expected_identity" ]] &&
    lock_directory_is_empty "$LOCK_DIR" &&
    rmdir "$LOCK_DIR" ||
    die "Could not remove the stale Skoobi operation lock: $LOCK_DIR"
  log "Recovered a stale Skoobi operation lock: $LOCK_DIR"
}

acquire_operation_lock() {
  local operation="${1:-}" attempt=0 identity="" owner=""
  local owner_identity="" snapshot="" status=0 uid=""
  [[ "$operation" =~ ^(update|uninstall)$ ]] ||
    die "Invalid Skoobi lifecycle operation lock name"
  LOCK_DIR="$PREFIX/.skoobi-operation.lock"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] acquire exclusive installer operation lock"
    return 0
  fi
  [[ ! -L "$PREFIX" && (! -e "$PREFIX" || -d "$PREFIX") ]] ||
    die "Install prefix must be a real directory"
  mkdir -p "$PREFIX"
  chmod 700 "$PREFIX"
  while [[ "$attempt" -lt 2 ]]; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      chmod 700 "$LOCK_DIR"
      if ! publish_operation_lock_owner "$operation"; then
        rm -f "$LOCK_DIR"/.owner.* "$LOCK_DIR/owner" >/dev/null 2>&1 || true
        rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
        die "Could not publish safe Skoobi operation lock metadata"
      fi
      LOCK_HELD=1
      return 0
    fi
    lock_private_directory "$LOCK_DIR" ||
      die "Skoobi operation lock path is unsafe: $LOCK_DIR"
    lock_directory_has_only 0 ||
      die "Skoobi operation lock state is unknown; inspect it before recovery: $LOCK_DIR"
    uid="$(lock_path_uid "$LOCK_DIR" || true)"
    [[ "$uid" == "$(id -u)" ]] ||
      die "Skoobi operation lock is not owned by the current user: $LOCK_DIR"
    identity="$(lock_path_identity "$LOCK_DIR" || true)"
    owner="$LOCK_DIR/owner"
    owner_identity="$(lock_path_identity "$owner" || true)"
    snapshot="$(cat "$owner" 2>/dev/null || true)"
    if [[ -z "$identity" || -z "$owner_identity" || -z "$snapshot" ]]; then
      die "Skoobi operation lock has no safe recovery metadata: $LOCK_DIR"
    fi
    if lock_owner_state "$owner"; then
      status=0
    else
      status=$?
    fi
    case "$status" in
      0)
        die "Another Skoobi ${LOCK_META_OPERATION} operation is active (pid $LOCK_META_PID); lock: $LOCK_DIR"
        ;;
      3)
        reclaim_stale_operation_lock \
          "$identity" "$owner_identity" "$snapshot"
        attempt=$((attempt + 1))
        ;;
      *)
        die "Skoobi operation lock state is unknown; inspect it before recovery: $LOCK_DIR"
        ;;
    esac
  done
  die "Could not acquire the Skoobi operation lock after stale recovery"
}

release_operation_lock() {
  local owner="$LOCK_DIR/owner" identity="" owner_identity="" snapshot=""
  [[ "$LOCK_HELD" == "1" ]] || return 0
  identity="$(lock_path_identity "$LOCK_DIR" || true)"
  owner_identity="$(lock_path_identity "$owner" || true)"
  snapshot="$(cat "$owner" 2>/dev/null || true)"
  [[ "$identity" == "$LOCK_IDENTITY" &&
      "$owner_identity" == "$LOCK_OWNER_IDENTITY" &&
      "$snapshot" == "$LOCK_OWNER_SNAPSHOT" ]] || return 1
  lock_private_directory "$LOCK_DIR" || return 1
  lock_directory_has_only 0 || return 1
  lock_parse_owner "$owner" || return 1
  [[ "$LOCK_META_TOKEN" == "$LOCK_TOKEN" && "$LOCK_META_PID" == "$$" ]] ||
    return 1
  [[ "$(lock_path_identity "$LOCK_DIR" || true)" == "$LOCK_IDENTITY" &&
      "$(lock_path_identity "$owner" || true)" == "$LOCK_OWNER_IDENTITY" &&
      "$(cat "$owner" 2>/dev/null || true)" == "$LOCK_OWNER_SNAPSHOT" ]] ||
    return 1
  rm -f "$owner" || return 1
  [[ "$(lock_path_identity "$LOCK_DIR" || true)" == "$LOCK_IDENTITY" ]] ||
    return 1
  lock_directory_is_empty "$LOCK_DIR" || return 1
  rmdir "$LOCK_DIR" || return 1
  LOCK_HELD=0
  LOCK_TOKEN=""
  LOCK_IDENTITY=""
  LOCK_OWNER_IDENTITY=""
  LOCK_OWNER_SNAPSHOT=""
}
