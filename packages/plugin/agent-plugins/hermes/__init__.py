import subprocess

TKR = __TKR_ARGV__
CONTEXT_FILE = __TKR_CONTEXT_FILE__
ARGS = ["rewrite", "--host", "hermes"]


def _rewrite(command, session):
    extra = ["--session", session] if isinstance(session, str) and session else []
    result = subprocess.run(
        TKR + ARGS + extra,
        input=command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=3,
        shell=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return result.stdout


def _pre_tool_call(tool_name=None, args=None, **kwargs):
    try:
        if tool_name != "terminal" or not isinstance(args, dict):
            return None
        command = args.get("command")
        if not isinstance(command, str) or not command.strip():
            return None
        rewritten = _rewrite(command, kwargs.get("session_id"))
        if not rewritten:
            return None
        return {"action": "modify", "args": {"command": rewritten}}
    except Exception:
        return None


def _reducer_section(*args, **kwargs):
    try:
        with open(CONTEXT_FILE, encoding="utf-8") as handle:
            return handle.read().strip()
    except Exception:
        return ""


def register(ctx):
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    if hasattr(ctx, "register_system_prompt_section"):
        try:
            ctx.register_system_prompt_section("tokmizer.reducer", _reducer_section, position="after_memory", max_chars=8000)
        except Exception:
            pass
