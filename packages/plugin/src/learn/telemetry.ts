import { redactCommand } from "./redact";
import { appendSpool, uploadSpool, type UploadResult } from "./spool";

const SAFE_WORD = /^[a-z0-9][a-z0-9._-]*$/i;
const SUBCMD = /^[a-z][a-z-]+$/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NEVER_LOG = new Set(["gh", "glab", "gup", "hub", "gist"]);
const TOKEN_PREFIX = /^(gh[a-z]_|github_pat_|gl(?:pat|rt|soat|imt|dt|ft|agent|oas)-|npm_|xox|sk-|sk_|eyj|a(?:kia|sia|gpa|ida|roa|npa)|aiza|hv[sb]\.)/i;
const MAX_BIN_LENGTH = 24;
const SAFE_SUB_BINS = new Set([
  "docker", "podman", "npm", "pnpm", "yarn", "npx", "bun", "deno",
  "cargo", "rustup", "go", "pip", "pip3", "uv", "poetry",
  "brew", "apt", "apt-get", "dnf", "yum", "pacman",
  "kubectl", "helm", "terraform", "aws", "gcloud", "az",
  "systemctl", "composer", "bundle", "gem", "dotnet", "prisma",
  "tkr", "rtk", "token"
]);

const PATHED_KNOWN_BINS = new Set([
  ...SAFE_SUB_BINS,
  "git", "gh",
  "node", "python", "python3", "bash", "sh", "zsh",
  "psql", "mysql", "sqlite3", "java", "ruby", "perl",
  "rg", "fd", "jq", "make", "gradle", "mvn",
  "vitest", "jest", "tsc", "esbuild", "vite", "webpack",
  "playwright", "rails", "rake"
]);

const KNOWN_PROGRAMS = new Set([
  ...PATHED_KNOWN_BINS,
  "cd", "cat", "head", "tail", "ls", "tree", "find", "grep", "wc", "nl", "sort", "cut", "uniq", "tr",
  "diff", "stat", "file", "du", "df", "ps", "yq", "pwd", "which", "echo", "printf", "seq", "sed", "awk",
  "gawk", "xargs", "sleep", "tar", "zip", "unzip", "rsync", "scp", "ssh", "curl", "wget", "dig", "host",
  "nslookup", "ping", "lsof", "journalctl", "iptables", "ip6tables", "open", "md5", "md5sum", "sha1sum",
  "sha224sum", "sha256sum", "sha384sum", "sha512sum", "shasum", "sudo", "env", "command", "time",
  "nodejs", "bunx", "pytest", "mypy", "dmypy", "pyright", "basedpyright", "ruff", "black", "ty",
  "gradlew", "mvnw", "mvnd", "ninja", "cmake", "bazel", "bazelisk", "sbt", "gcc", "clang", "gmake",
  "swift", "xcodebuild", "pod", "flutter", "nx", "turbo", "next", "eslint", "prettier", "biome",
  "oxlint", "golangci-lint", "shellcheck", "hadolint", "yamllint", "markdownlint", "mdl", "sqlfluff",
  "rubocop", "rspec", "bundler", "php", "artisan", "composer", "phpunit", "phpstan", "pest", "paratest",
  "pint", "mix", "javap", "jar", "docker-compose", "skopeo", "oc", "ecs", "nomad", "consul",
  "packer", "pulumi", "tofu", "ansible", "ansible-playbook", "vault", "sops", "vercel", "netlify",
  "wrangler", "firebase", "supabase", "stripe", "shopify", "theme-check", "redis-cli", "liquibase",
  "ollama", "ast-grep", "just", "task", "mise", "trunk", "pre-commit", "jj", "yadm", "gt", "quarto",
  "act", "jira", "fail2ban-client", "ctest", "pio", "platformio",
  "reducer", "restore", "read-tool", "grep-tool", "glob-tool", "bash-tool"
]);

const FORGE_VERBS = new Map<string, ReadonlySet<string>>([
  ["git", new Set([
    "status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "branch", "fetch", "pull", "push",
    "commit", "checkout", "switch", "merge", "rebase", "stash", "tag", "remote", "add", "reset", "restore",
    "clean", "grep"
  ])],
  ["gh", new Set(["pr", "issue", "run", "repo", "api"])]
]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c"]);

function resolveBin(token: string): string {
  if (!/[\\/]/.test(token)) return token;
  const last = token.split(/[\\/]/).filter((s) => s.length > 0).pop() ?? "";
  const base = last.toLowerCase().endsWith(".exe") ? last.slice(0, -4) : last;
  return PATHED_KNOWN_BINS.has(base.toLowerCase()) ? base : "";
}

function forgeLabel(family: string, verbs: ReadonlySet<string>, rest: string[]): string {
  let j = 0;
  while (family === "git" && j < rest.length && rest[j]!.startsWith("-")) j += GIT_OPTIONS_WITH_VALUE.has(rest[j]!) ? 2 : 1;
  const verb = (rest[j] ?? "").toLowerCase();
  return verbs.has(verb) ? `${family} ${verb}` : family;
}

function isNeverLogged(bin: string): boolean {
  const b = bin.toLowerCase();
  return b.startsWith("git") || NEVER_LOG.has(b);
}

export function commandName(raw: string): string {
  const toks = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < toks.length && ENV_ASSIGN.test(toks[i] ?? "")) i += 1;
  const bin = resolveBin(toks[i] ?? "");
  if (!bin || !SAFE_WORD.test(bin)) return "";
  if (bin.length > MAX_BIN_LENGTH) return "";
  const forge = FORGE_VERBS.get(bin.toLowerCase());
  if (forge) return forgeLabel(bin.toLowerCase(), forge, toks.slice(i + 1));
  if (isNeverLogged(bin)) return "";
  if (TOKEN_PREFIX.test(bin)) return "";
  if (redactCommand(bin) !== bin) return "";
  const sub = toks[i + 1];
  if (sub && isNeverLogged(sub)) return "";
  const keepSub = sub && SAFE_SUB_BINS.has(bin.toLowerCase()) && SUBCMD.test(sub);
  const out = keepSub ? `${bin} ${sub}` : bin;
  return out.slice(0, 64);
}

function isKnownProgram(name: string): boolean {
  return KNOWN_PROGRAMS.has((name.split(" ")[0] ?? "").toLowerCase());
}

export type TelemetryInput = {
  cmd: string;
  tokensSaved: number;
  tokensRestored?: number | undefined;
  rawTokens?: number | undefined;
  optimized: boolean;
  telemetryOptIn: boolean;
  sessionId?: string | undefined;
  host?: string | undefined;
};

export async function recordTelemetry(input: TelemetryInput): Promise<void> {
  if (!input.telemetryOptIn) return;
  const name = commandName(input.cmd);
  const safe = name && redactCommand(name) === name && isKnownProgram(name) ? name : "other";
  const sid = input.sessionId ? input.sessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) : "";
  appendSpool("telemetry", {
    cmd: safe,
    tokensSaved: Math.max(0, Math.round(input.tokensSaved)),
    ...(input.tokensRestored ? { tokensRestored: Math.max(0, Math.round(input.tokensRestored)) } : {}),
    ...(input.rawTokens != null ? { rawTokens: Math.max(0, Math.round(input.rawTokens)) } : {}),
    optimized: input.optimized,
    ...(sid ? { sessionId: sid } : {}),
    ...(input.host ? { host: input.host } : {})
  });
}

export async function flushTelemetry(baseUrl?: string): Promise<UploadResult> {
  return uploadSpool("telemetry", "/api/v1/telemetry", { baseUrl, consent: true });
}
