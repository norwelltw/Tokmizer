import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rewrite } from "../hooks-host/pre-tool-use";
import { rewriteShellCommand } from "../hooks-host/pre-tool-rewrite";

const has = (bin: string): boolean => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

describe("shell -c scripts are rewritten inside their quotes", () => {
  it.each([
    ["bash -c 'git status && cargo test'", "tkr-exec bash -c 'tkr-exec git status && tkr-exec cargo test'"],
    ["sh -c 'cd app; npm test'", "sh -c 'cd app; tkr-exec npm test'"],
    ['zsh -c "pytest -q"', 'zsh -c "tkr-exec pytest -q"'],
    ["bash -lc 'make build'", "bash -lc 'tkr-exec make build'"],
    ["/bin/bash -ec 'go test ./...'", "/bin/bash -ec 'tkr-exec go test ./...'"],
    ["fish -c 'git log -5'", "fish -c 'tkr-exec git log -5'"],
    ["cd x && bash -c 'cargo build' && ls", "cd x && bash -c 'tkr-exec cargo build' && tkr-exec ls"],
    ["bash -c 'git diff' arg0 one", "bash -c 'tkr-exec git diff' arg0 one"],
    ["bash -c 'echo \"$(git status)\"; git log'", "tkr-exec bash -c 'echo \"$(git status)\"; tkr-exec git log'"],
    ["bash -c \"sh -c 'git status'\"", "bash -c \"sh -c 'tkr-exec git status'\""]
  ])("%s", (cmd, expected) => {
    expect(rewrite(cmd)).toBe(expected);
  });

  it("leaves a piped shell -c producer unwrapped", () => {
    expect(rewrite("bash -c 'git log' | head -5")).toBe("bash -c 'git log' | tkr-exec head -5");
  });

  it.each([
    ["sh -c \"grep -rn import src | head -150\"", "tkr-exec sh -c \"grep -rn import src | tkr-exec head -150\""],
    ["sh -c 'git status && git diff --stat'", "tkr-exec sh -c 'tkr-exec git status && tkr-exec git diff --stat'"],
    ["bash -c 'cat a.txt; cat b.txt'", "tkr-exec bash -c 'tkr-exec cat a.txt; tkr-exec cat b.txt'"],
    ["bash -c 'npm test || cat npm-debug.log'", "tkr-exec bash -c 'tkr-exec npm test || tkr-exec cat npm-debug.log'"]
  ])("keeps an outer wrapper around a script whose commands combine their output: %s", (cmd, expected) => {
    expect(rewrite(cmd)).toBe(expected);
  });

  it.each([
    ["sh -c 'git log -n 30'", "sh -c 'tkr-exec git log -n 30'"],
    ["bash -c 'cat large.rs'", "bash -c 'tkr-exec cat large.rs'"],
    ["sh -c 'cd app && export CI=1 && npm test'", "sh -c 'cd app && export CI=1 && tkr-exec npm test'"],
    ["bash -c 'X=1; git status'", "bash -c 'X=1; tkr-exec git status'"]
  ])("lets a single producing command keep its own rule only: %s", (cmd, expected) => {
    expect(rewrite(cmd)).toBe(expected);
  });

  it("wraps the outer shell once when the hook runs again on its own output", () => {
    const once = rewrite("sh -c 'git status && git diff --stat'");
    expect(rewrite(once)).toBe(once);
  });

  it("escapes a quoted exec path inside a single-quoted script", () => {
    expect(rewrite("bash -c 'git status'", "'/x/tkr-exec'")).toBe("bash -c ''\\''/x/tkr-exec'\\'' git status'");
  });

  it.each([
    ["bash -c \"$CMD\""],
    ['bash -c "git log $REF"'],
    ['bash -c "git log `cat ref`"'],
    ["bash -c 'echo $HOME'"],
    ["bash -c 'git log' > out.txt"],
    ["bash -c 'git log' &"],
    ["bash -c 'git log'suffix"],
    ["bash -o pipefail -c 'git log'"],
    ["bash -c ''"],
    ["bash -c 'cat <<EOF\nx\nEOF'"],
    ["fish -c 'git status; and git log'"],
    ["fish -c 'git log (cat ref)'"],
    ["fish -lc 'git log'"],
    ["FOO=1 bash -c 'git log'"],
    ["X=\"$(bash -c 'git log')\""],
    ["bash script.sh"]
  ])("leaves %j untouched", (cmd) => {
    expect(rewrite(cmd)).toBe(cmd);
  });

  describe("rewritten scripts still run through the real shell", () => {
    let dir: string;
    let exec: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "tkr shell 'unwrap "));
      const script = join(dir, "fake-exec");
      writeFileSync(script, "#!/bin/sh\ncase \"$1\" in sh|bash|zsh|fish) printf 'OUTER:%s\\n' \"$1\"; exec \"$@\";; esac\nprintf 'WRAPPED:%s\\n' \"$*\"\n");
      chmodSync(script, 0o755);
      exec = `'${script.replace(/'/g, "'\\''")}'`;
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const shells = ["sh", "bash", "zsh", "fish"].filter(has);

    it.each(shells)("%s runs the wrapped inner commands", (shell) => {
      const cmd = `${shell} -c 'cat a; git status --short'`;
      const rewritten = rewrite(cmd, exec);
      expect(rewritten).not.toBe(cmd);
      const run = spawnSync("sh", ["-c", rewritten], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`OUTER:${shell}\nWRAPPED:cat a\nWRAPPED:git status --short\n`);
    });

    it.each(shells.filter((s) => s !== "fish"))("%s runs a wrapped double-quoted script", (shell) => {
      const rewritten = rewrite(`${shell} -c "cat b && git diff --stat"`, exec);
      const run = spawnSync("sh", ["-c", rewritten], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`OUTER:${shell}\nWRAPPED:cat b\nWRAPPED:git diff --stat\n`);
    });
  });
});

describe("tool subcommands of interpreters are wrapped, scripts and servers are not", () => {
  it.each([
    "bun install",
    "bun add zod",
    "bun test",
    "bun run build",
    "bun run test:unit --bail",
    "bun x tsc --noEmit",
    "deno test -A",
    "deno lint",
    "deno check main.ts",
    "deno task check",
    "php -l src/Cart.php",
    "php vendor/bin/phpunit",
    "php vendor/bin/pest --parallel",
    "php vendor/bin/phpstan analyse",
    "php run-tests.php -q tests",
    "php artisan migrate",
    "php artisan test",
    "/usr/local/bin/php artisan route:list"
  ])("wraps %s", (cmd) => {
    expect(rewrite(cmd)).toBe(`tkr-exec ${cmd}`);
  });

  it.each([
    "bun index.ts",
    "bun run index.ts",
    "bun run src/server.ts",
    "bun run dev",
    "bun run start --port 3000",
    "bun test --watch",
    "deno run main.ts",
    "deno serve main.ts",
    "deno task dev",
    "deno test --watch",
    "php script.php",
    "php -r 'echo 1;'",
    "php artisan serve",
    "php artisan tinker",
    "php artisan queue:work",
    "php -S localhost:8000"
  ])("leaves %s untouched", (cmd) => {
    expect(rewrite(cmd)).toBe(cmd);
  });
});

describe("permission gates see inside shell -c scripts", () => {
  let root: string;
  const noUsage = () => {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tkr-shell-perm-"));
    mkdirSync(join(root, "home"), { recursive: true });
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("USERPROFILE", join(root, "home"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("CLAUDE_PROJECT_DIR", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const route = (cmd: string, host: "grok" | "claude-code") =>
    rewriteShellCommand(cmd, { host, sessionId: "s", cwd: root, claudeDirs: { projectDir: root }, permissionMode: "bypassPermissions" }, "tkr-exec", noUsage);

  it("routes inspection and build scripts for agents without readable rules", () => {
    expect(route("bash -c 'git status && cargo test'", "grok")).toBe("tkr-exec bash -c 'tkr-exec git status && tkr-exec cargo test'");
  });

  it("leaves scripts that change state untouched for those agents", () => {
    expect(route("bash -c 'git status && git push'", "grok")).toBeNull();
    expect(route("sh -c 'rm -rf build'", "grok")).toBeNull();
  });

  it("honours a Claude Code deny rule that matches a command inside the script", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(git push:*)"] } }));
    expect(route("bash -c 'git status && git push origin main'", "claude-code")).toBeNull();
    expect(route("bash -c 'git status'", "claude-code")).toBe("bash -c 'tkr-exec git status'");
  });
});

describe("the outer wrapper squeezes the combined output of a chained script", () => {
  const lines = (n: number, prefix: string): string => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";

  it("routes the joined command line to the generic Bash rule", async () => {
    const { processOutput } = await import("../engine");
    const output = lines(40, " M packages/plugin/src/file") + lines(260, " packages/plugin/src/file.ts | 2 +-");
    const r = await processOutput("sh -c tkr-exec git status && tkr-exec git diff --stat", output, null, { exitCode: 0, verbosity: "compact" });
    expect(r.filterId).toBe("bash-tool");
    expect(r.filteredBytes).toBeLessThan(r.rawBytes);
    expect(r.output).toMatch(/more lines omitted/);
  });

  it("caps a piped listing the same way the PostToolUse hook did before unwrapping", async () => {
    const { processOutput } = await import("../engine");
    const output = lines(150, "packages/plugin/src/a.ts:1:import x from");
    const r = await processOutput("sh -c grep -rn import packages/plugin/src | tkr-exec head -150", output, null, { exitCode: 0, verbosity: "compact" });
    expect(r.filterId).toBe("bash-tool");
    expect(r.filteredBytes).toBeLessThan(r.rawBytes);
  });
});
