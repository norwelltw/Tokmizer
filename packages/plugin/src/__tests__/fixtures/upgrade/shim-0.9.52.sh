#!/bin/sh
if [ -n "${CLAUDECODE:-}${CLAUDE_CODE_ENTRYPOINT:-}${CLAUDE_CODE:-}${CLAUDE_CODE_VERSION:-}${ANTHROPIC_CLAUDE_CODE:-}${CODEX_VERSION:-}${CODEX_CLI:-}${OPENAI_CODEX:-}${CODEX_THREAD_ID:-}${CODEX_SESSION_ID:-}" ] || { [ -z "${CURSOR_VERSION:-}${CURSOR_TRACE_ID:-}${CLINE_VERSION:-}${CLINE_API_KEY:-}${AIDER_VERSION:-}${AIDER_MODEL:-}${GEMINI_CLI_VERSION:-}${GEMINI_API_KEY:-}${WINDSURF_VERSION:-}${WINDSURF_USER:-}${GITHUB_COPILOT_VERSION:-}${COPILOT_INTEGRATION_ID:-}" ] && [ ! -t 1 ]; }; then
  set -f
  _tk_d='__HOME__/.tokmizer/shims'
  _tk_c='git'
  _tk_o=$IFS; IFS=:; _tk_p=; _tk_x=
  for _tk_e in $PATH; do
    [ -n "$_tk_e" ] || continue
    [ "$_tk_e" -ef "$_tk_d" ] && continue
    _tk_p=${_tk_p:+$_tk_p:}$_tk_e
    [ -z "$_tk_x" ] && [ -f "$_tk_e/$_tk_c" ] && [ -x "$_tk_e/$_tk_c" ] && _tk_x=$_tk_e/$_tk_c
  done
  IFS=$_tk_o; PATH=$_tk_p; export PATH; set +f
  [ -n "$_tk_x" ] || { echo "$_tk_c: command not found" >&2; exit 127; }
  exec "$_tk_x" "$@"
fi
exec node '__JS__' --as 'git' "$@"
