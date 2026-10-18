import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { recordUsageSync } from "../usage";
import { singleBinary } from "../self-command";
import { execUsable } from "./exec-health";
import { claudeShellNames, resolvableHead, shadowedByShell, type ShellNames } from "./shell-heads";

const EXCEPTIONS = new Set([
  "tkr", "tkr-exec", "token", "claude",
  "cd", "export", "source", "echo", "mkdir", "rm", "mv", "cp", "chmod", "ln",
  "true", "false", ":", "test", "[", "exit", "return",
  "nohup", "sudo", "doas", "env"
]);

const SHELL_WORDS = new Set([
  "for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done",
  "case", "esac", "select", "function", "time", "coproc", "in",
  "!", "[[", "]]", "{", "}", ".",
  "declare", "typeset", "local", "readonly", "unset", "set", "shift", "trap",
  "wait", "read", "eval", "exec", "break", "continue", "pushd", "popd", "dirs",
  "alias", "unalias", "hash", "ulimit", "umask", "getopts", "let", "shopt",
  "builtin", "command", "compgen", "complete", "disown", "suspend", "jobs",
  "fg", "bg", "kill", "history", "fc", "bind", "enable", "caller", "type",
  "printf", "pwd", "times", "logout", "mapfile", "readarray", "help", "which",
  "print", "whence", "where", "autoload", "zmodload", "setopt", "unsetopt", "emulate", "noglob",
  "rehash", "functions", "bindkey", "zle", "vared", "sched", "limit", "unlimit", "zstyle", "zparseopts", "ttyctl"
]);

const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish",
  "python", "python3", "python2", "node", "ruby", "perl", "php", "awk", "sed",
  "deno", "bun"
]);

const LONG_RUNNING = "(?:dev|start|serve|watch|preview)";
const INTERPRETER_TOOL_RE = new RegExp(
  "^(?:\\S*/)?(?:" +
  "bun\\s+(?:install|i|add|remove|rm|update|outdated|audit|test|build|pm|x)(?:\\s|$)" +
  `|bun\\s+run\\s+(?!${LONG_RUNNING}(?:\\s|$))[A-Za-z0-9:_-]+(?:\\s|$)` +
  "|deno\\s+(?:test|lint|fmt|check|compile|install|info|doc|bench|outdated)(?:\\s|$)" +
  `|deno\\s+task\\s+(?!${LONG_RUNNING}(?:\\s|$))[A-Za-z0-9:_-]+(?:\\s|$)` +
  "|php\\s+-l(?:\\s|$)" +
  "|php\\s+(?:\\S*/)?(?:phpunit|pest|paratest|phpstan|pint|ecs|php-cs-fixer|psalm|rector|run-tests\\.php)(?:\\s|$)" +
  "|php\\s+artisan\\s+(?!(?:serve|tinker|queue:work|queue:listen|horizon|octane:start|reverb:start|schedule:work|pail|dev)(?:\\s|$))\\S" +
  ")"
);
const WATCH_FLAG_RE = /(?:^|\s)--watch(?:\s|=|$)/;

function interpreterTool(trimmed: string): boolean {
  return INTERPRETER_TOOL_RE.test(trimmed) && !WATCH_FLAG_RE.test(trimmed);
}

const SHELL_C_RE = /^((?:\S*\/)?(sh|bash|zsh|dash|ksh|fish)\s+(-[elux]*c[elux]*)\s+)(['"])/;
const FISH_UNSAFE_RE = /[()$]|(?:^|[;&|\n]\s*)(?:and|or|not|begin|end|if|else|switch|case|while|for|function|return)(?:\s|;|$)/;
const MAX_SHELL_DEPTH = 3;

type ShellScript = { script: string; start: number; end: number; quote: string };

function shellScript(trimmed: string): ShellScript | null {
  const m = SHELL_C_RE.exec(trimmed);
  if (!m) return null;
  const fish = m[2] === "fish";
  if (fish && m[3] !== "-c") return null;
  const quote = m[4]!;
  const start = m[1]!.length + 1;
  const end = trimmed.indexOf(quote, start);
  if (end <= start) return null;
  const rest = trimmed.slice(end + 1);
  if (rest && !/^\s/.test(rest)) return null;
  const script = trimmed.slice(start, end);
  if (quote === '"' && /[$`\\!]/.test(script)) return null;
  if (fish && FISH_UNSAFE_RE.test(script)) return null;
  return { script, start, end, quote };
}

const SCRIPT_SETUP_HEADS = new Set(["cd", "export", "set", "unset", "source", ".", "true", ":", "pushd", "popd"]);

function scriptChainsOutput(script: string): boolean {
  const producing = splitTopLevel(script).filter((seg) => {
    if (seg.kind !== "cmd" || seg.unsafe) return false;
    const head = firstWord(seg.text);
    return head !== "" && !SCRIPT_SETUP_HEADS.has(head) && !ASSIGN_RE.test(head);
  });
  return producing.length > 1;
}

type HeadCheck = (head: string) => boolean;

function unwrapShellScript(trimmed: string, exec: string, depth: number, headOk: HeadCheck, onWrap?: WrapSink): string | null {
  if (depth >= MAX_SHELL_DEPTH) return null;
  const parsed = shellScript(trimmed);
  if (!parsed) return null;
  const { script, start, end, quote } = parsed;
  const wrapped: string[] = [];
  const inner = rewriteAt(script, exec, depth + 1, headOk, (segment) => wrapped.push(segment));
  if (inner === script) return null;
  if (quote === '"' && /["$`]/.test(inner)) return null;
  const embedded = quote === "'" ? inner.replace(/'/g, "'\\''") : inner;
  const unwrapped = `${trimmed.slice(0, start)}${embedded}${trimmed.slice(end)}`;
  const chained = scriptChainsOutput(script);
  if (onWrap) for (const segment of chained ? [trimmed, ...wrapped] : wrapped) onWrap(segment);
  return chained ? `${exec} ${unwrapped}` : unwrapped;
}

const STREAM_FOLLOW_RE = /(?:^|\s)(?:--follow|-[0-9a-zA-Z]*f[a-zA-Z]*)(?:\s|=|$)/;
const STREAM_LOG_HEADS = new Set(["docker", "podman", "kubectl", "nerdctl", "docker-compose", "stern", "flyctl"]);

function isStreamingCommand(trimmed: string, head: string): boolean {
  const base = basename(head);
  if (base === "tail" || base === "journalctl") return STREAM_FOLLOW_RE.test(trimmed);
  if (base === "stern") return true;
  if (STREAM_LOG_HEADS.has(base)) return /\blogs?\b/.test(trimmed) && STREAM_FOLLOW_RE.test(trimmed);
  return false;
}

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const FUNC_DEF_RE = /^[A-Za-z_][A-Za-z0-9_-]*\s*\(\s*\)/;
const FUNC_DEF_ANYWHERE = /(?:^|[;&|\n({])\s*[A-Za-z_][A-Za-z0-9_-]*\s*\(\s*\)/;

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

function topLevelMask(cmd: string): boolean[] | null {
  const mask: boolean[] = new Array<boolean>(cmd.length).fill(false);
  const stack: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    const ctx = stack[stack.length - 1];
    if (ctx === "'") {
      if (c === "'") stack.pop();
      i += 1;
      continue;
    }
    if (c === "\\") {
      if (next === undefined) return null;
      i += 2;
      continue;
    }
    if (ctx === "$'") {
      if (c === "'") stack.pop();
      i += 1;
      continue;
    }
    if (c === "$" && (next === "(" || next === "{")) {
      stack.push(next === "(" ? ")" : "}");
      i += 2;
      continue;
    }
    if (c === "`") {
      if (ctx === "`") stack.pop();
      else stack.push("`");
      i += 1;
      continue;
    }
    if (ctx === '"') {
      if (c === '"') stack.pop();
      i += 1;
      continue;
    }
    if (c === "$" && next === "'") {
      stack.push("$'");
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      stack.push(c);
      i += 1;
      continue;
    }
    if (c === "(" || (c === "{" && ctx === "}")) {
      stack.push(c === "(" ? ")" : "}");
      i += 1;
      continue;
    }
    if (c === ctx) {
      stack.pop();
      i += 1;
      continue;
    }
    if (c === ")" && ctx === undefined) return null;
    mask[i] = ctx === undefined;
    i += 1;
  }
  return stack.length === 0 ? mask : null;
}

function hasTopLevelRedirect(seg: string): boolean {
  const mask = topLevelMask(seg);
  if (!mask) return true;
  for (let i = 0; i < seg.length; i++) {
    if (mask[i] && seg[i] === ">") return true;
  }
  return false;
}

type Segment = { kind: "cmd" | "sep"; text: string; unsafe?: boolean };

export function splitTopLevel(cmd: string): Segment[] {
  const mask = topLevelMask(cmd);
  if (!mask) return [{ kind: "cmd", text: cmd, unsafe: true }];
  const segs: Segment[] = [];
  let buf = "";
  let i = 0;

  const pushCmd = () => {
    if (buf.length > 0) {
      segs.push({ kind: "cmd", text: buf });
      buf = "";
    }
  };
  const pushSep = (sep: string, width: number) => {
    pushCmd();
    segs.push({ kind: "sep", text: sep });
    i += width;
  };

  while (i < cmd.length) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    if (mask[i]) {
      if (c === ">" && next === "|") {
        buf += ">|";
        i += 2;
        continue;
      }
      if (c === "&" && next === "&") {
        pushSep("&&", 2);
        continue;
      }
      if (c === "&" && next !== ">") {
        const trimmed = buf.replace(/\s+$/, "");
        const last = trimmed[trimmed.length - 1];
        if (last !== ">" && last !== "<" && last !== "&") {
          pushSep("&", 1);
          continue;
        }
      }
      if (c === "|" && next === "|") {
        pushSep("||", 2);
        continue;
      }
      if (c === "|" && next === "&") {
        pushSep("|&", 2);
        continue;
      }
      if (c === ";" && next === ";") {
        const triple = cmd[i + 2] === "&";
        pushSep(triple ? ";;&" : ";;", triple ? 3 : 2);
        continue;
      }
      if (c === ";" || c === "\n" || c === "|") {
        pushSep(c, 1);
        continue;
      }
    }
    buf += c;
    i += 1;
  }

  pushCmd();
  return segs;
}

function firstWord(seg: string): string {
  return seg.trim().split(/\s+/)[0] ?? "";
}

export type HookHost =
  | "claude-code" | "codex" | "cursor" | "gemini-cli"
  | "opencode" | "kilo" | "amp" | "vibe" | "antigravity" | "openclaw" | "pi" | "omp" | "hermes"
  | "copilot" | "droid" | "trae" | "qwen-code" | "crush" | "junie" | "zcode" | "grok";

export function execInvocation(host?: HookHost, platform: NodeJS.Platform = process.platform): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const windows = platform === "win32";
    const prefix = host && host !== "claude-code" && host !== "codex" && !windows ? `TOKMIZER_HOST=${host} ` : "";
    if (windows && (!host || host === "claude-code")) {
      const native = join(here, "..", "bin", "tkr-exec.exe");
      if (existsSync(native)) return execUsable(native, platform) ? `'${native.replace(/\\/g, "/").replace(/'/g, "'\\''")}'` : null;
    }
    const executable = join(here, "..", "bin", "tkr-exec");
    if (!windows && existsSync(executable)) return execUsable(executable, platform) ? `${prefix}'${executable.replace(/'/g, "'\\''")}'` : null;
    if (singleBinary()) {
      const self = windows ? process.execPath.replace(/\\/g, "/") : process.execPath;
      return `${prefix}'${self.replace(/'/g, "'\\''")}' exec`;
    }
    const js = join(here, "..", "bin", "tkr-exec.js");
    if (!existsSync(js)) return null;
    return `${prefix}node '${js.replace(/'/g, "'\\''")}'`;
  } catch {
    return null;
  }
}

type WrapSink = (segment: string) => void;

export function rewrite(cmd: string, exec = "tkr-exec", headOk: HeadCheck = () => true, onWrap?: WrapSink): string {
  return rewriteAt(cmd, exec, 0, headOk, onWrap);
}

function rewriteAt(cmd: string, exec: string, depth: number, headOk: HeadCheck, onWrap?: WrapSink): string {
  if (cmd.includes("<<")) return cmd;
  if (FUNC_DEF_ANYWHERE.test(cmd)) return cmd;
  const segs = splitTopLevel(cmd);
  const out: string[] = [];
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]!;
    if (seg.kind === "sep" || seg.unsafe) {
      out.push(seg.text);
      continue;
    }
    const trimmed = seg.text.trim();
    if (!trimmed) {
      out.push(seg.text);
      continue;
    }
    const head = firstWord(trimmed);
    const next = segs[s + 1];
    const midPipe = next?.kind === "sep" && (next.text === "|" || next.text === "|&");
    const backgrounded = next?.kind === "sep" && next.text === "&";
    const unwrapped = !midPipe && !backgrounded && !hasTopLevelRedirect(seg.text) && !seg.text.includes("<(") && !seg.text.includes(">(")
      ? unwrapShellScript(trimmed, exec, depth, headOk, onWrap)
      : null;
    if (unwrapped !== null) {
      out.push(`${seg.text.match(/^\s*/)?.[0] ?? ""}${unwrapped}${seg.text.match(/\s*$/)?.[0] ?? ""}`);
      continue;
    }
    if (
      trimmed === exec ||
      (trimmed.startsWith(exec) && /^\s/.test(trimmed.slice(exec.length))) ||
      EXCEPTIONS.has(head) ||
      SHELL_WORDS.has(head) ||
      ((INTERPRETERS.has(head) || INTERPRETERS.has(basename(head))) && !interpreterTool(trimmed)) ||
      ASSIGN_RE.test(head) ||
      head.startsWith("(") ||
      head.startsWith("#") ||
      head.startsWith("<") ||
      head.startsWith(">") ||
      FUNC_DEF_RE.test(trimmed) ||
      isStreamingCommand(trimmed, head) ||
      head.endsWith(")") ||
      midPipe ||
      backgrounded ||
      hasTopLevelRedirect(seg.text) ||
      seg.text.includes("<(") ||
      seg.text.includes(">(") ||
      (head === "node" && trimmed.includes("tkr-exec.js")) ||
      !headOk(head)
    ) {
      out.push(seg.text);
      continue;
    }
    const leading = seg.text.match(/^\s*/)?.[0] ?? "";
    const trailing = seg.text.match(/\s*$/)?.[0] ?? "";
    onWrap?.(trimmed);
    out.push(`${leading}${exec} ${trimmed}${trailing}`);
  }
  return out.join("");
}

const CODEX_SAFE_INPUT_KEYS = new Set([
  "command", "workdir", "timeout_ms", "yield_time_ms", "max_output_tokens", "shell", "login", "tty", "description"
]);

export type PreToolUsePayload = {
  tool_input?: { command?: unknown; run_in_background?: boolean; [key: string]: unknown };
  tool_name?: string;
  session_id?: string;
  cwd?: unknown;
  permission_mode?: unknown;
};

const READONLY_HEADS = new Set([
  "cd", "cat", "head", "tail", "ls", "tree", "find", "grep", "rg", "wc", "nl", "sort", "cut",
  "diff", "stat", "file", "du", "df", "ps", "jq", "yq", "pwd", "which"
]);
const READONLY_GIT = new Set([
  "log", "diff", "show", "status", "blame", "ls-files", "rev-parse", "describe", "shortlog"
]);
const UNSAFE_OPTIONS: Record<string, RegExp> = {
  find: /^-(?:delete|exec|execdir|ok|okdir|fprint|fls)/,
  sort: /^(?:-[^-]*o|--output|--compress-program)/,
  rg: /^(?:--pre|-[^-]*z|--search-zip)/,
  yq: /^(?:-[^-]*[is]|--inplace|--split-exp)/,
  file: /^(?:-C|--compile)/,
  tree: /^(?:-o|--output|-R$|-H$)/,
  git: /^(?:--output|--ext-diff|--textconv|-c$|--exec-path|--git-dir|--work-tree)/,
  eslint: /^--fix/
};
const SCRIPT_TASKS = ["test", "run test", "run build", "run lint", "run typecheck"];
const BUILD_TEST_TASKS: Record<string, ReadonlySet<string>> = {
  npm: new Set(SCRIPT_TASKS),
  pnpm: new Set([...SCRIPT_TASKS, "build", "lint", "typecheck"]),
  yarn: new Set([...SCRIPT_TASKS, "build", "lint", "typecheck"]),
  bun: new Set(SCRIPT_TASKS),
  cargo: new Set(["test", "build", "check", "clippy"]),
  go: new Set(["test", "build", "vet"]),
  mvn: new Set(["test", "compile", "verify"]),
  gradle: new Set(["test", "build", "check"]),
  dotnet: new Set(["test", "build"])
};
const BUILD_TEST_HEADS = new Set(["pytest", "tsc", "vitest", "jest", "eslint", "mypy"]);

function readOnlyCommand(cmd: string, buildsAndTests: boolean, depth = 0): boolean {
  if (/\$|`|<\(|>\(|\\\r?\n/.test(cmd)) return false;
  if (/>/.test(cmd.replace(/2>&1|[12]?>\s*\/dev\/null/g, ""))) return false;
  for (const seg of splitTopLevel(cmd)) {
    if (seg.kind === "sep") continue;
    if (seg.unsafe) return false;
    const wrapped = depth < MAX_SHELL_DEPTH ? shellScript(seg.text.trim()) : null;
    if (wrapped) {
      if (!readOnlyCommand(wrapped.script, buildsAndTests, depth + 1)) return false;
      continue;
    }
    const words = seg.text.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/['"\\]/g, ""));
    if (words.length === 0) continue;
    if (words.some((w) => ASSIGN_RE.test(w))) return false;
    const head = basename(words[0]!);
    if (head !== words[0]) return false;
    const unsafe = UNSAFE_OPTIONS[head];
    if (unsafe && words.slice(1).some((w) => unsafe.test(w))) return false;
    if (head === "git" ? READONLY_GIT.has(words[1] ?? "") : READONLY_HEADS.has(head)) continue;
    if (buildsAndTests && BUILD_TEST_HEADS.has(head)) continue;
    const tasks = buildsAndTests ? BUILD_TEST_TASKS[head] : undefined;
    if (tasks && (tasks.has(words[1] ?? "") || (words[1] === "run" && tasks.has(`run ${words[2] ?? ""}`)))) continue;
    return false;
  }
  return true;
}

export function buildPreToolUseOutput(
  payload: PreToolUsePayload,
  host: "claude-code" | "codex",
  exec: string | null = execInvocation(host),
  recordUsage: (sessionId: string, routed: boolean) => void = recordUsageSync,
  claudeDirs: ClaudeDirs = currentClaudeDirs(),
  pathEnv: string | undefined = process.env.PATH
): string | null {
  if (!isRecord(payload) || payload.tool_name !== "Bash") return null;
  const input = payload.tool_input;
  if (!isRecord(input) || input.run_in_background) return null;
  const cmd = input.command;
  if (typeof cmd !== "string" || !cmd) return null;
  if (host === "codex" && Object.keys(input).some((k) => !CODEX_SAFE_INPUT_KEYS.has(k))) return null;
  const cwdField = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : input.workdir;
  const cwd = typeof cwdField === "string" && cwdField ? cwdField : undefined;
  const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : "unknown";
  const permissionMode = typeof payload.permission_mode === "string" ? payload.permission_mode : undefined;
  const decision = rewriteShellDecision(cmd, { host, sessionId, cwd, claudeDirs, pathEnv, permissionMode }, exec, recordUsage);
  if (!decision) return null;
  const updatedInput = { ...input, command: decision.command };
  return JSON.stringify({
    hookSpecificOutput:
      host === "codex"
        ? { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput }
        : decision.allowedBy
          ? { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `Tokmizer: allowed by your rule ${decision.allowedBy}`, updatedInput }
          : { hookEventName: "PreToolUse", updatedInput }
  });
}

type Matcher = (cmd: string) => boolean;
type AllowRule = { rule: string; matches: Matcher };
type RuleSet = { matchers: Matcher[]; complete: boolean; allow?: Matcher[]; allowsEverything?: boolean; guards?: Matcher[]; trustedAllow?: AllowRule[] } | "unreadable";

function readConfig(path: string, jsonc: boolean): unknown | "missing" | "unreadable" {
  if (!existsSync(path)) return "missing";
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(jsonc ? stripJsonComments(raw) : raw);
  } catch {
    return "unreadable";
  }
}

function stripJsonComments(raw: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += raw[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && raw[i + 1] === "*") {
      i = raw.indexOf("*/", i + 2);
      if (i === -1) return "";
      i += 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

function claudeManagedFiles(): string[] {
  const dir =
    process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : process.platform === "win32" ? "C:\\Program Files\\ClaudeCode"
    : "/etc/claude-code";
  const files = [join(dir, "managed-settings.json")];
  try {
    for (const name of readdirSync(join(dir, "managed-settings.d"))) {
      if (name.endsWith(".json")) files.push(join(dir, "managed-settings.d", name));
    }
  } catch {
    return files;
  }
  return files;
}

function readRuleFiles(files: string[], jsonc: boolean, collect: (config: Record<string, unknown>, matchers: Matcher[]) => boolean, complete: boolean): RuleSet {
  const matchers: Matcher[] = [];
  for (const file of files) {
    const config = readConfig(file, jsonc);
    if (config === "missing") continue;
    if (config === "unreadable" || !isRecord(config) || !collect(config, matchers)) return "unreadable";
  }
  return { matchers, complete };
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

export type ClaudeDirs = { projectDir?: string | undefined; configDir?: string | undefined };

export function currentClaudeDirs(): ClaudeDirs {
  return { projectDir: process.env.CLAUDE_PROJECT_DIR, configDir: process.env.CLAUDE_CONFIG_DIR };
}

function claudeRules(cwd: string, dirs: ClaudeDirs): RuleSet {
  const settings = (dir: string) => [join(dir, "settings.json"), join(dir, "settings.local.json")];
  const project = (dir: string) => settings(join(dir, ".claude"));
  const home = join(homedir(), ".claude");
  type Scope = "managed" | "loaded" | "loadedLocal" | "project" | "extra";
  const loadedDir = dirs.configDir || home;
  const groups: [string[], Scope][] = [
    [claudeManagedFiles(), "managed"],
    [[join(loadedDir, "settings.json")], "loaded"],
    [[join(loadedDir, "settings.local.json")], "loadedLocal"],
    [dirs.configDir ? settings(home) : [], "extra"],
    [dirs.projectDir ? project(dirs.projectDir) : [], "project"],
    [ancestors(cwd).flatMap(project), "extra"]
  ];
  const allow: Matcher[] = [];
  const narrow: Record<Scope, AllowRule[]> = { managed: [], loaded: [], loadedLocal: [], project: [], extra: [] };
  const blanket: Record<Scope, boolean> = { managed: false, loaded: false, loadedLocal: false, project: false, extra: false };
  let managedOnly = false;
  let scope: Scope = "managed";
  const collect = (config: Record<string, unknown>, matchers: Matcher[]): boolean => {
    const permissions = config.permissions;
    if (scope === "managed" && (config.allowManagedPermissionRulesOnly === true ||
      (isRecord(permissions) && permissions.allowManagedPermissionRulesOnly === true))) managedOnly = true;
    if (permissions === undefined) return true;
    if (!isRecord(permissions)) return false;
    for (const key of ["deny", "ask", "allow"]) {
      const list = stringList(permissions[key]);
      if (!list) return false;
      for (const rule of list) {
        const m = /^\s*Bash\s*(?:\(([\s\S]*)\))?\s*$/.exec(rule);
        if (!m) continue;
        if (key !== "allow") matchers.push(globMatcher((m[1] ?? "*").replace(/:\*$/, " *")));
        else if (m[1] === undefined || m[1].trim() === "*") blanket[scope] = true;
        else {
          allow.push(globMatcher(m[1].replace(/:\*$/, " *")));
          const exact = exactMatcher(m[1]);
          if (exact) narrow[scope].push({ rule: rule.trim(), matches: exact });
        }
      }
    }
    return true;
  };
  const matchers: Matcher[] = [];
  for (const [files, group] of groups) {
    scope = group;
    const rules = readRuleFiles(files, false, collect, true);
    if (rules === "unreadable") return "unreadable";
    matchers.push(...rules.matchers);
  }
  const allowsEverything = blanket.managed || ((blanket.loaded || blanket.loadedLocal) && !managedOnly);
  const trustedAllow = [...narrow.managed, ...(managedOnly ? [] : narrow.loaded)];
  return { matchers: [...matchers, ...(allowsEverything ? [] : allow)], complete: true, allow, allowsEverything, guards: matchers, trustedAllow };
}

function cursorRules(cwd: string): RuleSet {
  const files = [
    join(homedir(), ".cursor", "cli-config.json"),
    ...ancestors(cwd).map((d) => join(d, ".cursor", "cli.json"))
  ];
  return readRuleFiles(files, true, (config, matchers) => {
    const permissions = config.permissions;
    if (permissions === undefined) return true;
    if (!isRecord(permissions)) return false;
    const list = stringList(permissions.deny);
    if (!list) return false;
    for (const rule of list) {
      const m = /^\s*Shell\s*(?:\(([\s\S]*)\))?\s*$/.exec(rule);
      if (!m) continue;
      const body = m[1] ?? "*";
      const colon = body.indexOf(":");
      matchers.push(globMatcher(colon === -1 ? `${body} *` : `${body.slice(0, colon)} ${body.slice(colon + 1)}`));
    }
    return true;
  }, false);
}

function geminiSystemDir(): string {
  return process.platform === "darwin" ? "/Library/Application Support/GeminiCli"
    : process.platform === "win32" ? "C:\\ProgramData\\gemini-cli"
    : "/etc/gemini-cli";
}

const SHELL_TOOL_RULE = /^\s*(?:run_shell_command|ShellTool)\s*(?:\(([\s\S]*)\))?\s*$/;

function geminiSettingsMatchers(config: Record<string, unknown>, matchers: Matcher[]): boolean {
  const tools = config.tools;
  if (tools !== undefined && !isRecord(tools)) return false;
  const lists = [stringList(config.excludeTools), stringList(isRecord(tools) ? tools.exclude : undefined)];
  for (const list of lists) {
    if (!list) return false;
    for (const rule of list) {
      const m = SHELL_TOOL_RULE.exec(rule);
      if (m) matchers.push(globMatcher(m[1] === undefined ? "*" : `${m[1]}*`));
    }
  }
  return true;
}

type TomlValue = string | string[];

function tomlString(quoted: string): string | null {
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return null;
  }
}

function tomlValue(text: string): TomlValue | null {
  const value = text.trim();
  if (value.startsWith('"""') || value.startsWith("'''")) return null;
  if (value.startsWith("[")) {
    if (!/\]\s*(?:#.*)?$/.test(value)) return null;
    const items: string[] = [];
    for (const m of value.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)) {
      const item = m[2] ?? tomlString(`"${m[1]}"`);
      if (item === null) return null;
      items.push(item);
    }
    return items;
  }
  if (value.startsWith('"')) {
    const m = /^"((?:\\.|[^"\\])*)"/.exec(value);
    return m ? tomlString(`"${m[1]}"`) : null;
  }
  if (value.startsWith("'")) {
    const m = /^'([^']*)'/.exec(value);
    return m ? m[1]! : null;
  }
  return value.replace(/\s*#.*$/, "");
}

function geminiPolicyMatchers(raw: string, matchers: Matcher[]): boolean {
  for (const block of raw.split(/^\s*\[\[\s*rule\s*\]\]\s*$/m).slice(1)) {
    const fields: Record<string, TomlValue> = {};
    for (const line of block.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const m = /^\s*([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = tomlValue(m[2]!);
      if (value === null) return false;
      fields[m[1]!] = value;
    }
    const decision = fields.decision;
    if (decision !== "deny" && decision !== "ask_user") continue;
    const toolNames = fields.toolName === undefined ? ["*"] : [fields.toolName].flat();
    if (!toolNames.some((t) => t === "*" || SHELL_TOOL_RULE.test(t))) continue;
    const prefixes = fields.commandPrefix === undefined ? [] : [fields.commandPrefix].flat();
    const regexes = [fields.commandRegex, fields.argsPattern].flat().filter((r): r is string => typeof r === "string");
    if (prefixes.length === 0 && regexes.length === 0) {
      matchers.push(() => true);
      continue;
    }
    for (const prefix of prefixes) matchers.push(globMatcher(`${prefix}*`));
    for (const source of regexes) {
      let re: RegExp;
      try {
        re = new RegExp(source);
      } catch {
        return false;
      }
      matchers.push((cmd) => re.test(JSON.stringify({ command: cmd })) || matchesAnyStart(re, cmd));
    }
  }
  return true;
}

function policyFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".toml")).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function geminiRules(cwd: string): RuleSet {
  const system = geminiSystemDir();
  const settingsFiles = [
    join(system, "system-defaults.json"),
    join(system, "settings.json"),
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
    process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
    join(homedir(), ".gemini", "settings.json"),
    ...ancestors(cwd).map((d) => join(d, ".gemini", "settings.json"))
  ].filter((f): f is string => !!f);
  const settings = readRuleFiles(settingsFiles, true, geminiSettingsMatchers, false);
  if (settings === "unreadable") return settings;
  for (const file of [...policyFiles(join(homedir(), ".gemini", "policies")), ...policyFiles(join(system, "policies"))]) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return "unreadable";
    }
    if (!geminiPolicyMatchers(raw, settings.matchers)) return "unreadable";
  }
  return settings;
}

function opencodePermissionMatchers(permission: unknown, matchers: Matcher[]): boolean {
  if (permission === undefined) return true;
  if (typeof permission === "string") {
    if (permission !== "allow") matchers.push(() => true);
    return true;
  }
  if (!isRecord(permission)) return false;
  for (const key of ["bash", "shell", "*"]) {
    const rule = permission[key];
    if (rule === undefined) continue;
    if (typeof rule === "string") {
      if (rule !== "allow") matchers.push(() => true);
      continue;
    }
    if (!isRecord(rule)) return false;
    for (const [pattern, action] of Object.entries(rule)) {
      if (action !== "allow") matchers.push(globMatcher(pattern.replace(/\?/g, "*")));
    }
  }
  return true;
}

function opencodeConfigMatchers(config: Record<string, unknown>, matchers: Matcher[]): boolean {
  if (config.permissions !== undefined) return false;
  if (!opencodePermissionMatchers(config.permission, matchers)) return false;
  for (const key of ["agent", "agents", "mode"]) {
    const agents = config[key];
    if (agents === undefined) continue;
    if (!isRecord(agents)) return false;
    for (const agent of Object.values(agents)) {
      if (!isRecord(agent)) continue;
      if (agent.permissions !== undefined || !opencodePermissionMatchers(agent.permission, matchers)) return false;
    }
  }
  return true;
}

function opencodeAgentFilesMentionPermissions(dirs: string[]): boolean {
  for (const dir of dirs) {
    for (const sub of ["agent", "agents", "mode", "modes"]) {
      let names: string[];
      try {
        names = readdirSync(join(dir, sub));
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          if (name.endsWith(".md") && /permission/i.test(readFileSync(join(dir, sub, name), "utf8"))) return true;
        } catch {
          return true;
        }
      }
    }
  }
  return false;
}

function opencodeRules(cwd: string): RuleSet {
  const globalDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const projectDirs = ancestors(cwd);
  const configDirs = [globalDir, ...projectDirs.map((d) => join(d, ".opencode"))];
  if (opencodeAgentFilesMentionPermissions(configDirs)) return "unreadable";
  const names = ["opencode.json", "opencode.jsonc", "config.json"];
  const files = [
    ...names.map((n) => join(globalDir, n)),
    process.env.OPENCODE_CONFIG,
    ...projectDirs.flatMap((d) => [...names.slice(0, 2).map((n) => join(d, n)), ...names.slice(0, 2).map((n) => join(d, ".opencode", n))])
  ].filter((f): f is string => !!f);
  const rules = readRuleFiles(files, true, opencodeConfigMatchers, true);
  if (rules === "unreadable") return rules;
  for (const inline of [process.env.OPENCODE_CONFIG_CONTENT, process.env.OPENCODE_PERMISSION]) {
    if (!inline) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(inline));
    } catch {
      return "unreadable";
    }
    const ok = inline === process.env.OPENCODE_PERMISSION
      ? opencodePermissionMatchers(parsed, rules.matchers)
      : isRecord(parsed) && opencodeConfigMatchers(parsed, rules.matchers);
    if (!ok) return "unreadable";
  }
  return rules;
}

function antigravityRules(): RuleSet {
  return readRuleFiles([join(homedir(), ".gemini", "antigravity-cli", "settings.json")], true, (config, matchers) => {
    const permissions = config.permissions;
    if (permissions === undefined) return true;
    if (!isRecord(permissions)) return false;
    for (const key of ["deny", "ask"]) {
      const list = stringList(permissions[key]);
      if (!list) return false;
      for (const rule of list) {
        const m = /^\s*command\s*\(([\s\S]*)\)\s*$/.exec(rule);
        if (!m) continue;
        const body = m[1]!.trim();
        if (!body.startsWith("regex:")) {
          matchers.push(globMatcher(body === "*" ? "*" : `${body} *`));
          continue;
        }
        let re: RegExp;
        try {
          re = new RegExp(body.slice(6));
        } catch {
          return false;
        }
        matchers.push((cmd) => matchesAnyStart(re, cmd));
      }
    }
    return true;
  }, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globRegex(pattern: string): RegExp {
  const norm = pattern.trim().replace(/\s+/g, " ");
  const tail = norm.endsWith(" *") && norm.length > 2;
  const body = (tail ? norm.slice(0, -2) : norm).split("*").map(escapeRegex).join("[\\s\\S]*");
  return new RegExp(`^${body}${tail ? "(?: [\\s\\S]*)?" : ""}(?= |$)`);
}

const MAX_MATCH_WORDS = 512;

function commandWords(cmd: string): string[][] {
  const words = cmd.replace(/['"\\]/g, "").split(/[\s;&|(){}<>`$]+/).filter(Boolean);
  return [words, words.map(basename)];
}

function matchesAnyStart(re: RegExp, cmd: string): boolean {
  if (re.test(cmd) || re.test(cmd.trim().replace(/\s+/g, " "))) return true;
  for (const words of commandWords(cmd)) {
    if (words.length > MAX_MATCH_WORDS) return true;
    for (let i = 0; i < words.length; i++) {
      if (re.test(words.slice(i).join(" "))) return true;
    }
  }
  return false;
}

function globMatcher(pattern: string): Matcher {
  const re = globRegex(pattern);
  return (cmd) => matchesAnyStart(re, cmd);
}

function exactMatcher(pattern: string): Matcher | null {
  const norm = pattern.trim().replace(/:\*$/, " *");
  const tail = norm.endsWith(" *");
  const body = tail ? norm.slice(0, -2) : norm;
  if (!body || body.includes("*") || /\s\s|[^\S ]|^ | $/.test(body)) return null;
  const re = new RegExp(`^${escapeRegex(body)}${tail ? "(?: [\\s\\S]*)?" : ""}$`);
  return (cmd) => re.test(cmd);
}

export function ruleMatchesCommand(pattern: string, cmd: string): boolean {
  return globMatcher(pattern)(cmd);
}

const RULE_READERS: Partial<Record<HookHost, (cwd: string, dirs: ClaudeDirs) => RuleSet>> = {
  "claude-code": claudeRules,
  cursor: cursorRules,
  "gemini-cli": geminiRules,
  opencode: opencodeRules,
  antigravity: antigravityRules
};

const INSPECTION_ONLY_HOSTS = new Set<HookHost>(["codex"]);

const PROTECTED_PATH_RE = /(?:^|[\s=:/~])\.(?:git|claude|vscode|idea|husky)(?=[/\s;|&)]|$)|(?:^|[\s=:/~])\.(?:bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|zlogout|gitconfig|gitmodules|ripgreprc|mcp\.json)(?![A-Za-z0-9_])/;

function hostRules(host: HookHost, cwd: string | undefined, dirs: ClaudeDirs): RuleSet {
  const reader = RULE_READERS[host];
  return reader ? reader(cwd ?? process.cwd(), dirs) : { matchers: [], complete: false };
}

function ruleGate(rules: RuleSet, cmd: string, host: HookHost): boolean {
  if (rules === "unreadable") return false;
  if (PROTECTED_PATH_RE.test(cmd.replace(/['"\\]/g, ""))) return false;
  if (rules.matchers.some((matches) => matches(cmd))) return false;
  return rules.complete || readOnlyCommand(cmd, !INSPECTION_ONLY_HOSTS.has(host));
}

export function rewriteAllowed(cmd: string, host: HookHost, cwd: string | undefined, dirs: ClaudeDirs = currentClaudeDirs()): boolean {
  return ruleGate(hostRules(host, cwd, dirs), cmd, host);
}

export type RewriteContext = {
  host: HookHost;
  sessionId: string;
  cwd?: string | undefined;
  claudeDirs?: ClaudeDirs | undefined;
  pathEnv?: string | undefined;
  permissionMode?: string | undefined;
};

const ALLOW_RULE_MODES = new Set(["default", "acceptEdits", "dontAsk"]);

function rewriteWithoutPrompt(rules: RuleSet, context: RewriteContext): boolean {
  if (context.host !== "claude-code") return true;
  if (context.permissionMode === "bypassPermissions") return true;
  return rules !== "unreadable" && rules.allowsEverything === true && ALLOW_RULE_MODES.has(context.permissionMode ?? "");
}

function headCheck(context: RewriteContext, dirs: ClaudeDirs): HeadCheck {
  const pathEnv = "pathEnv" in context ? context.pathEnv : process.env.PATH;
  let names: ShellNames | undefined;
  return (head) => {
    if (context.host !== "claude-code") return resolvableHead(head, context.cwd, pathEnv);
    names ??= claudeShellNames(dirs.configDir);
    if (!resolvableHead(head, context.cwd, pathEnv) && !names.paths.some((path) => resolvableHead(head, context.cwd, path))) return false;
    return head.includes("/") || !shadowedByShell(head, names);
  };
}

const SIMPLE_COMMAND_RE = /^[^\s;&|<>()$`\\{}*?[\]~#!]+(?: [^\s;&|<>()$`\\{}*?[\]~#!]+)*$/;

function narrowAllowRule(rules: RuleSet, cmd: string, context: RewriteContext): string | null {
  if (context.host !== "claude-code" || rules === "unreadable" || rewriteWithoutPrompt(rules, context)) return null;
  if (!ALLOW_RULE_MODES.has(context.permissionMode ?? "") || !SIMPLE_COMMAND_RE.test(cmd)) return null;
  if (PROTECTED_PATH_RE.test(cmd.replace(/['"]/g, ""))) return null;
  if ((rules.guards ?? []).some((matches) => matches(cmd))) return null;
  return (rules.trustedAllow ?? []).find((allow) => allow.matches(cmd))?.rule ?? null;
}

export type ShellRewrite = { command: string; allowedBy?: string };

export function rewriteShellDecision(
  cmd: string,
  context: RewriteContext,
  exec: string | null,
  recordUsage: (sessionId: string, routed: boolean) => void
): ShellRewrite | null {
  if (!exec || /["\\$`;&|<>(){}]|'\\''/.test(exec)) return null;
  const dirs = context.claudeDirs ?? currentClaudeDirs();
  const rules = hostRules(context.host, context.cwd, dirs);
  const allowedBy = narrowAllowRule(rules, cmd, context);
  let rewritten = allowedBy || ruleGate(rules, cmd, context.host) ? rewrite(cmd, exec, headCheck(context, dirs)) : cmd;
  if (rewritten !== cmd && rules !== "unreadable" && (allowedBy
    ? (rules.guards ?? []).some((matches) => matches(rewritten))
    : rules.matchers.some((matches) => matches(rewritten)) || (rules.allow ?? []).some((matches) => matches(rewritten) && !matches(cmd)))) rewritten = cmd;
  recordUsage(context.sessionId, rewritten !== cmd);
  if (rewritten === cmd) return null;
  if (allowedBy) return { command: rewritten, allowedBy };
  return rewriteWithoutPrompt(rules, context) ? { command: rewritten } : null;
}

export function rewriteShellCommand(
  cmd: string,
  context: RewriteContext,
  exec: string | null,
  recordUsage: (sessionId: string, routed: boolean) => void
): string | null {
  return rewriteShellDecision(cmd, context, exec, recordUsage)?.command ?? null;
}
