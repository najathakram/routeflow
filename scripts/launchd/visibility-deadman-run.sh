#!/bin/sh
# Wrapper the LaunchDaemon runs (com.routeflow.visibility-deadman.daemon.plist).
#
# A LaunchDaemon has no login session, so `gh` has no keychain/hosts.yml to read. This script loads
# a GitHub token from a root-only file, exports it as GH_TOKEN (which `gh` honours), and execs the
# dead-man switch for ONE poll. The token never appears in the plist, `ps` output or the repo.
#
# Environment (set by the plist, no defaults for the first three on purpose):
#   VISIBILITY_DEADMAN_REPO_DIR    absolute path of the routeflow checkout
#   VISIBILITY_DEADMAN_NODE_BIN    absolute path of node
#   VISIBILITY_DEADMAN_TOKEN_FILE  file holding the token (one line), owned by root, mode 600
#
# The token must belong to the repo OWNER (or an admin): use a classic PAT with `repo` scope.
# The script checks `viewerPermission`, which is the ACCOUNT's role and says nothing about the
# token's scope, so it logs a not-admin incident (exit 5) for the wrong account only. Prove the
# token can really flip with the one-time scratch-repo test in the runbook.
#
# Exit 78 (EX_CONFIG) when misconfigured; otherwise the dead-man switch's own exit code.
set -eu

fail() {
  echo "visibility-deadman-run: $1" >&2
  exit 78
}

: "${VISIBILITY_DEADMAN_REPO_DIR:?not set}"
: "${VISIBILITY_DEADMAN_NODE_BIN:?not set}"
: "${VISIBILITY_DEADMAN_TOKEN_FILE:?not set}"

[ -f "$VISIBILITY_DEADMAN_TOKEN_FILE" ] || fail "token file not found: $VISIBILITY_DEADMAN_TOKEN_FILE"

# Refuse a token file anyone but the owner can read (macOS `stat -f`, GNU `stat -c` as fallback).
mode=$(stat -f '%Lp' "$VISIBILITY_DEADMAN_TOKEN_FILE" 2>/dev/null || stat -c '%a' "$VISIBILITY_DEADMAN_TOKEN_FILE")
case "$mode" in
  400 | 600) ;;
  *) fail "token file mode is $mode, want 600 (chmod 600 $VISIBILITY_DEADMAN_TOKEN_FILE)" ;;
esac

GH_TOKEN=$(head -n 1 "$VISIBILITY_DEADMAN_TOKEN_FILE" | tr -d '[:space:]')
[ -n "$GH_TOKEN" ] || fail "token file is empty: $VISIBILITY_DEADMAN_TOKEN_FILE"
export GH_TOKEN

cd "$VISIBILITY_DEADMAN_REPO_DIR"
exec "$VISIBILITY_DEADMAN_NODE_BIN" scripts/visibility-deadman.mjs --once
