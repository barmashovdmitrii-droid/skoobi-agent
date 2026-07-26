#!/usr/bin/env bash
set -euo pipefail

for node_dir in /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin; do
  if [[ -x "$node_dir/node" ]]; then
    export PATH="$node_dir:$PATH"
    exec "$@"
  fi
done

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  if [[ "$node_major" =~ ^[0-9]+$ ]] && ((node_major >= 22)); then
    exec "$@"
  fi
fi

echo "with-node22: Node.js 22 or newer was not found in Homebrew node@22 locations or PATH" >&2
exit 127
