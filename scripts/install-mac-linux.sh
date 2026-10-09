#!/usr/bin/env bash
set -euo pipefail

err() { printf 'tkr install: %s\n' "$*" >&2; exit 1; }
log() { printf 'tkr: %s\n' "$*"; }

command -v node >/dev/null 2>&1 || err "Node.js 20.11+ is required."
command -v npm >/dev/null 2>&1 || err "npm is required."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || major === 20 && minor >= 11 ? 0 : 1)' || err "Node.js 20.11+ is required."

log "Installing @tokmizer/plugin from npm..."
npm install -g @tokmizer/plugin
command -v tkr >/dev/null 2>&1 || err "tkr is not on PATH. Add the npm global bin directory to PATH and run tkr shim install."

tkr shim install </dev/null
log "Done. Open a new terminal. Tokmizer is free and does not require an account."
log "For Codex, also run: tkr setup-codex"
log "Check the installation with: tkr status"
