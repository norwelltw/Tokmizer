#!/usr/bin/env bash
set -euo pipefail

err() { printf 'tkr install: %s\n' "$*" >&2; exit 1; }
log() { printf 'tkr: %s\n' "$*"; }

node_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || major === 20 && minor >= 11 ? 0 : 1)' 2>/dev/null
}

work=""

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

install_standalone() {
  local os arch key base line name sum root bindir unavailable
  unavailable="Install Node.js 20.11+ and retry."
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) err "No standalone build for $(uname -s). $unavailable" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) err "No standalone build for $(uname -m). $unavailable" ;;
  esac
  key="$os-$arch"
  base="${TOKMIZER_DOWNLOAD_BASE:-https://github.com/norwelltw/Tokmizer/releases/latest/download}"
  root="${TOKMIZER_INSTALL_DIR:-$HOME/.local/share/tokmizer}"
  bindir="${TOKMIZER_BIN_DIR:-$HOME/.local/bin}"
  command -v curl >/dev/null 2>&1 || err "curl is required."
  command -v tar >/dev/null 2>&1 || err "tar is required."
  work="$(mktemp -d)"
  trap 'rm -rf "${work:-}"' EXIT
  curl -fsSL "$base/SHA256SUMS" -o "$work/SHA256SUMS" || err "Could not download the standalone build. $unavailable"
  line="$(grep -E "^[0-9a-f]{64}  tokmizer-[0-9][^ /]*-$key\.tar\.gz$" "$work/SHA256SUMS" | head -n 1)" || true
  [ -n "$line" ] || err "No standalone build for $key. $unavailable"
  sum="${line%%  *}"
  name="${line#*  }"
  log "Downloading $name..."
  curl -fsSL "$base/$name" -o "$work/$name" || err "Could not download $name."
  [ "$(sha256_of "$work/$name")" = "$sum" ] || err "Checksum mismatch for $name."
  tar -xzf "$work/$name" -C "$work"
  "$work/${name%.tar.gz}/dist/bin/tkr" --single-check >/dev/null 2>&1 || err "The downloaded executable does not run on this system. $unavailable"
  mkdir -p "$root" "$bindir"
  rm -rf "${root:?}/${name%.tar.gz}"
  mv "$work/${name%.tar.gz}" "$root/${name%.tar.gz}"
  ln -sfn "${name%.tar.gz}" "$root/current"
  ln -sf "$root/current/dist/bin/tkr" "$bindir/tkr"
  ln -sf "$root/current/dist/bin/tkr-exec" "$bindir/tkr-exec"
  case ":$PATH:" in
    *":$bindir:"*) ;;
    *) PATH="$bindir:$PATH"; log "Add $bindir to your PATH." ;;
  esac
}

claude_code_present() {
  [ -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ] || command -v claude >/dev/null 2>&1
}

claude_before=0
if claude_code_present; then claude_before=1; fi

standalone=0
if [ "${TOKMIZER_STANDALONE:-}" = "1" ] || ! node_ready; then
  log "Installing the standalone tkr executable (Node.js not needed)..."
  install_standalone
  standalone=1
else
  log "Installing @tokmizer/plugin from npm..."
  npm install -g @tokmizer/plugin
fi
command -v tkr >/dev/null 2>&1 || err "tkr is not on PATH. Add its directory to PATH and run tkr shim install."

tkr shim install </dev/null
if [ "$standalone" = "1" ] && [ "$claude_before" = "1" ]; then
  tkr setup-claude </dev/null || log "Could not add the Claude Code hooks. Run: tkr setup-claude"
fi
tkr setup --all </dev/null || log "Some agents could not be set up. Run: tkr setup --all"
log "Done. Tokmizer is free and does not require an account. Your shell profile was not changed."
log "For Aider, Cline or Windsurf, start them with: tkr wrap <agent>"
log "Check the installation with: tkr status"
