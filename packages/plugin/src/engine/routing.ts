const WRAPPER_TOKENS = new Set(["sudo", "command", "time", "nice", "nohup", "env", "stdbuf", "timeout"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const TOOL_SYNTHETIC_RE = /^([a-z]+)-tool(?::\s|$)/;

export function normalizeHead(segment: string): string {
  const trimmed = segment.trim();
  const tokens = trimmed.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (ASSIGNMENT_RE.test(t)) {
      i++;
      continue;
    }
    if (WRAPPER_TOKENS.has(t)) {
      i++;
      if (t === "timeout" && i < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i]!)) i++;
      while ((t === "stdbuf" || t === "nice") && i < tokens.length && tokens[i]!.startsWith("-")) i++;
      continue;
    }
    break;
  }
  if (i >= tokens.length) return trimmed;
  const head = tokens[i]!;
  const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
  const rest = tokens.slice(i + 1);
  return rest.length ? `${base} ${rest.join(" ")}` : base;
}

const QUIET_HEADS = new Set([
  "cd", "export", "source", "set", "unset", "mkdir", "true", ":", "pushd", "popd",
  "alias", "ulimit", "umask", "echo", "printf", "sleep", "touch", "rm", "cp", "mv",
  "chmod", "ln"
]);

function splitTopLevel(cmd: string, listOnly: boolean): string[] {
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  const segments: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === ";") {
        segments.push(cmd.slice(start, i));
        start = i + 1;
      } else if (c === "|" && cmd[i + 1] === "|") {
        segments.push(cmd.slice(start, i));
        i++;
        start = i + 1;
      } else if (c === "|") {
        if (!listOnly) {
          segments.push(cmd.slice(start, i));
          start = i + 1;
        }
      } else if (c === "&" && cmd[i + 1] === "&") {
        segments.push(cmd.slice(start, i));
        i++;
        start = i + 1;
      }
    }
  }
  segments.push(cmd.slice(start));
  return segments;
}

function lastPipeSegment(seg: string): string {
  const parts = splitTopLevel(seg, false);
  for (let j = parts.length - 1; j >= 0; j--) {
    const s = parts[j]!.trim();
    if (s) return s;
  }
  return seg.trim();
}

export function producingSegment(cmd: string): string | null {
  const listSegs = splitTopLevel(cmd, true).map((s) => s.trim()).filter(Boolean);
  if (listSegs.length === 0) return null;
  for (const earlier of listSegs.slice(0, -1)) {
    const head = normalizeHead(earlier).split(/\s+/)[0] ?? "";
    if (!QUIET_HEADS.has(head)) return null;
  }
  return lastPipeSegment(listSegs[listSegs.length - 1]!);
}

export function lastSegment(cmd: string): string {
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  const segments: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === "|" || c === ";") {
        segments.push(cmd.slice(start, i));
        if (c === "|" && cmd[i + 1] === "|") i++;
        start = i + 1;
      } else if (c === "&" && cmd[i + 1] === "&") {
        segments.push(cmd.slice(start, i));
        i++;
        start = i + 1;
      }
    }
  }
  segments.push(cmd.slice(start));
  for (let j = segments.length - 1; j >= 0; j--) {
    const s = segments[j]!.trim();
    if (s) return s;
  }
  return cmd.trim();
}

const RUNNER_PREFIX_RE = /^(?:npx|bunx|uvx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx)|(?:uv|poetry|pipenv|hatch|pdm|rye)\s+run|bundle\s+exec|python[0-9.]*\s+-m)\s+(?=[^\s-])/;

export function unwrapRunner(command: string): string | null {
  const m = RUNNER_PREFIX_RE.exec(command);
  return m ? normalizeHead(command.slice(m[0].length)) : null;
}

export function routingCandidates(cmd: string): string[] {
  const m = TOOL_SYNTHETIC_RE.exec(cmd);
  let inner = cmd;
  if (m) {
    if (m[1] !== "bash") return [cmd];
    const sep = cmd.indexOf(": ");
    if (sep < 0) return [cmd];
    inner = cmd.slice(sep + 2);
  }
  const producing = producingSegment(inner);
  const candidate = producing ? normalizeHead(producing) : null;
  const unwrapped = candidate ? unwrapRunner(candidate) : null;
  const candidates = [unwrapped, candidate, cmd].filter((c): c is string => !!c);
  return [...new Set(candidates)];
}
