#!/usr/bin/env bash
# Deploy openclaw to the Mac Mini (miniclaw).
#
# Builds locally, rsyncs dist + deps to the openclaw user's repo,
# and restarts the gateway. No git pull on the remote needed.
#
# Usage: scripts/deploy-miniclaw.sh [--profile <name>] [--port <port>] [--skip-build] [--skip-restart]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="miniclaw"
REMOTE_USER="openclaw"

PROFILE=""
PORT="18789"
SKIP_BUILD=0
SKIP_RESTART=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)    PROFILE="$2"; shift 2 ;;
    --port)       PORT="$2"; shift 2 ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--profile <name>] [--port <port>] [--skip-build] [--skip-restart]"
      echo "  --profile <name>  Deploy to an isolated profile (openclaw-{name}/ dir, ~/.openclaw-{name}/ state)"
      echo "  --port <port>     Gateway port (default: 18789)"
      echo "  --skip-build      Skip local build, rsync existing dist/"
      echo "  --skip-restart    Deploy files but don't restart the gateway"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Derive remote dir from profile name (default: openclaw-ecs for backward compat)
if [[ -n "${PROFILE}" ]]; then
  REMOTE_DIR="/Users/${REMOTE_USER}/projects/openclaw-${PROFILE}"
else
  REMOTE_DIR="/Users/${REMOTE_USER}/projects/openclaw-ecs"
fi

log() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cd "${ROOT_DIR}"

# 1) Build locally
if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  log "Building locally"
  pnpm build
else
  log "Skipping build (--skip-build)"
fi

[[ -f dist/entry.js ]] || fail "dist/entry.js not found — run pnpm build first"

# 2) Rsync to remote
log "Syncing to ${REMOTE_HOST}:${REMOTE_DIR}"
rsync -az --delete \
  --rsync-path="sudo rsync" \
  dist/ \
  "${REMOTE_HOST}:${REMOTE_DIR}/dist/"

rsync -az --delete \
  --rsync-path="sudo rsync" \
  node_modules/ \
  "${REMOTE_HOST}:${REMOTE_DIR}/node_modules/"

rsync -az --delete \
  --rsync-path="sudo rsync" \
  extensions/ \
  "${REMOTE_HOST}:${REMOTE_DIR}/extensions/"

# Sync essential root files
rsync -az \
  --rsync-path="sudo rsync" \
  package.json openclaw.mjs pnpm-lock.yaml pnpm-workspace.yaml \
  "${REMOTE_HOST}:${REMOTE_DIR}/"

# Fix ownership back to openclaw user
ssh "${REMOTE_HOST}" "sudo chown -R ${REMOTE_USER}:staff ${REMOTE_DIR}/dist ${REMOTE_DIR}/node_modules ${REMOTE_DIR}/extensions ${REMOTE_DIR}/package.json ${REMOTE_DIR}/openclaw.mjs ${REMOTE_DIR}/pnpm-lock.yaml ${REMOTE_DIR}/pnpm-workspace.yaml"

# Sync personas to profile state dir
PERSONAS_DIR="${HOME}/.openclaw/personas"
if [[ -d "${PERSONAS_DIR}" ]]; then
  if [[ -n "${PROFILE}" ]]; then
    REMOTE_STATE_DIR="/Users/${REMOTE_USER}/.openclaw-${PROFILE}"
  else
    REMOTE_STATE_DIR="/Users/${REMOTE_USER}/.openclaw"
  fi
  log "Syncing personas to ${REMOTE_HOST}:${REMOTE_STATE_DIR}/personas/"
  ssh "${REMOTE_HOST}" "sudo mkdir -p ${REMOTE_STATE_DIR}/personas"
  rsync -az --delete \
    --rsync-path="sudo rsync" \
    "${PERSONAS_DIR}/" \
    "${REMOTE_HOST}:${REMOTE_STATE_DIR}/personas/"
  ssh "${REMOTE_HOST}" "sudo chown -R ${REMOTE_USER}:staff ${REMOTE_STATE_DIR}/personas"
fi

log "Sync complete"

# 3) Restart gateway
# The OpenClaw Mac app auto-respawns the gateway when killed (PPID=1).
# We just need to kill the old process and let the Mac app restart it
# with the newly synced dist. No manual start needed.
if [[ "${SKIP_RESTART}" -eq 0 ]]; then
  log "Restarting gateway on ${REMOTE_HOST} (kill port ${PORT})"
  ssh "${REMOTE_HOST}" "sudo kill -9 \$(lsof -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true"

  if [[ -n "${PROFILE}" ]]; then
    # Profile deploys: start the gateway manually (Mac app only manages the default instance)
    log "Starting profile gateway: OPENCLAW_PROFILE=${PROFILE} on port ${PORT}"
    ssh "${REMOTE_HOST}" "sudo -u ${REMOTE_USER} bash -lc 'cd ${REMOTE_DIR} && OPENCLAW_PROFILE=${PROFILE} nohup node openclaw.mjs gateway run --port ${PORT} --bind loopback --force > /tmp/openclaw-gateway-${PROFILE}.log 2>&1 &'"
    sleep 5
  else
    # Default deploy: let the Mac app respawn the gateway
    sleep 8
  fi

  log "Verifying gateway"
  if ssh "${REMOTE_HOST}" "lsof -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1"; then
    echo "OK: gateway listening on port ${PORT}"
  else
    echo "WARN: gateway not yet listening on ${PORT}"
    if [[ -n "${PROFILE}" ]]; then
      echo "Check /tmp/openclaw-gateway-${PROFILE}.log for errors."
    else
      echo "The Mac app may need a moment to respawn, or check the app is running."
    fi
  fi
else
  log "Skipping restart (--skip-restart)"
fi

log "Deploy complete"
