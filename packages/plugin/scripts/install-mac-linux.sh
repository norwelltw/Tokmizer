#!/usr/bin/env bash
set -euo pipefail

err() { printf 'tkr install: %s\n' "$*" >&2; exit 1; }
log() { printf 'tkr: %s\n' "$*"; }

node_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || major === 20 && minor >= 11 ? 0 : 1)' 2>/dev/null
}

work=""

RELEASE_KEY_PEM='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQqaFzuV5RhhcjaYgECQqM1faOtWjIE5U54zyPADPSgM=
-----END PUBLIC KEY-----'
RELEASE_KEY_SSH='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEKmhc7leUYYXI2mIBAkKjNX2jrVoyBOVOeM8jwAz0oD'

openssl_ed25519() {
  local help
  command -v openssl >/dev/null 2>&1 || return 1
  openssl pkey -pubin -in "$1" -noout >/dev/null 2>&1 || return 1
  help="$(openssl pkeyutl -help 2>&1 || true)"
  case "$help" in *-rawin*) return 0 ;; esac
  return 1
}

ssh_keygen_sig() {
  local out
  command -v ssh-keygen >/dev/null 2>&1 || return 1
  out="$(ssh-keygen -Y verify </dev/null 2>&1 || true)"
  case "$out" in *"unknown option"*|*"illegal option"*|*"invalid option"*) return 1 ;; esac
  return 0
}

verify_sums() {
  local dir="$1" base="$2"
  printf '%s\n' "$RELEASE_KEY_PEM" > "$dir/release.pem"
  if openssl_ed25519 "$dir/release.pem"; then
    curl -fsSL "$base/SHA256SUMS.sig" -o "$dir/SHA256SUMS.sig" || err "The release is not signed (SHA256SUMS.sig is missing). Do not install this build."
    openssl pkeyutl -verify -pubin -inkey "$dir/release.pem" -rawin -in "$dir/SHA256SUMS" -sigfile "$dir/SHA256SUMS.sig" >/dev/null 2>&1 ||
      err "Release signature check failed. Do not install this build."
    log "Release signature verified (openssl)."
    return 0
  fi
  if ssh_keygen_sig; then
    curl -fsSL "$base/SHA256SUMS.sshsig" -o "$dir/SHA256SUMS.sshsig" || err "The release is not signed (SHA256SUMS.sshsig is missing). Do not install this build."
    printf 'tokmizer-release %s\n' "$RELEASE_KEY_SSH" > "$dir/allowed_signers"
    ssh-keygen -Y verify -f "$dir/allowed_signers" -I tokmizer-release -n tokmizer-release -s "$dir/SHA256SUMS.sshsig" < "$dir/SHA256SUMS" >/dev/null 2>&1 ||
      err "Release signature check failed. Do not install this build."
    log "Release signature verified (ssh-keygen)."
    return 0
  fi
  if [ "${TOKMIZER_REQUIRE_SIG:-}" = "1" ]; then
    err "Cannot verify the release signature: install OpenSSL 3 or OpenSSH 8.1+, or unset TOKMIZER_REQUIRE_SIG."
  fi
  log "Warning: cannot verify the release signature (no OpenSSL 3 with Ed25519, no ssh-keygen -Y). Relying on SHA256SUMS only."
}

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
  verify_sums "$work" "$base"
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
