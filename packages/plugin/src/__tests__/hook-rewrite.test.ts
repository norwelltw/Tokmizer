import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { rewrite, splitTopLevel, buildPreToolUseOutput } from "../hooks-host/pre-tool-use";

describe("entry-guard URL encoding", () => {
  it("matches import.meta.url for paths containing a space (encoded, not raw concat)", () => {
    const entry = "/Users/a b/plugin/dist/hooks/pre-tool-use.js";
    const naive = `file://${entry}`;
    const encoded = pathToFileURL(entry).href;
    expect(encoded).not.toBe(naive);
    expect(encoded).toContain("%20");
    expect(pathToFileURL(entry).href).toBe(encoded);
  });
});

describe("PreToolUse rewrite", () => {
  it("wraps a simple command", () => {
    expect(rewrite("git log")).toBe("tkr-exec git log");
  });

  it("wraps each segment of compound &&", () => {
    expect(rewrite("git pull && npm test")).toBe(
      "tkr-exec git pull && tkr-exec npm test"
    );
  });

  it("skips exception commands like cd, export, source", () => {
    expect(rewrite("cd /tmp && ls")).toBe("cd /tmp && tkr-exec ls");
  });

  it("does not double-wrap if tkr-exec already present", () => {
    expect(rewrite("tkr-exec git log")).toBe("tkr-exec git log");
  });

  it("wraps only the last segment of a pipeline", () => {
    expect(rewrite("ps aux | grep node")).toBe("ps aux | tkr-exec grep node");
  });

  it("leaves every mid-pipeline segment raw", () => {
    expect(rewrite("a b | c d | e f")).toBe("a b | c d | tkr-exec e f");
  });

  it("never wraps an inline function definition into invalid syntax", () => {
    expect(rewrite("f() { grep x; }")).toBe("f() { grep x; }");
    expect(rewrite("deploy () { cargo build && cargo test; }")).toBe("deploy () { cargo build && cargo test; }");
  });

  it("leaves a command alone when it defines a function with the function keyword", () => {
    expect(rewrite("function git { echo SHADOWED; }; git status")).toBe("function git { echo SHADOWED; }; git status");
    expect(rewrite("function ls {\n  echo x\n}\nls")).toBe("function ls {\n  echo x\n}\nls");
    expect(rewrite("cd x && function f() { grep y; }; f")).toBe("cd x && function f() { grep y; }; f");
  });

  it("does not wrap case-pattern labels", () => {
    const out = rewrite("case $x in a) grep y ;; b) cat z ;; esac");
    expect(out).not.toContain("tkr-exec b)");
    expect(out).not.toContain("tkr-exec a)");
  });

  it("does not wrap a command with a leading input redirect (parity with Rust)", () => {
    expect(rewrite("< in.txt cd /tmp")).toBe("< in.txt cd /tmp");
    expect(rewrite("< f source ./env.sh")).toBe("< f source ./env.sh");
    expect(rewrite("true && < f bash -c 'rm x'")).toBe("true && < f bash -c 'rm x'");
  });

  it("does not split inside an unquoted ${...} brace expansion", () => {
    expect(rewrite("echo ${x:-a && b}")).toBe("echo ${x:-a && b}");
    expect(rewrite("grep ${PAT:-foo|bar} f")).toBe("tkr-exec grep ${PAT:-foo|bar} f");
    expect(rewrite("make ${TARGET:-build;test}")).toBe("tkr-exec make ${TARGET:-build;test}");
  });

  it("does not corrupt a subshell-background (cmd &) by splitting the inner &", () => {
    expect(rewrite("(server &) && grep x f")).toBe("(server &) && tkr-exec grep x f");
  });

  it("leaves a subshell opaque (does not split its inner separators)", () => {
    expect(rewrite("(cd /tmp; ls)")).toBe("(cd /tmp; ls)");
  });

  it("treats a top-level newline as a separator and wraps each line", () => {
    expect(rewrite("git status\nnpm test")).toBe("tkr-exec git status\ntkr-exec npm test");
  });

  it("does not split a newline inside single quotes", () => {
    expect(rewrite("echo 'a\nb'")).toBe("echo 'a\nb'");
  });

  it("never wraps sudo/doas/env (parity with Rust EXCLUDED_BINS)", () => {
    expect(rewrite("sudo apt update")).toBe("sudo apt update");
    expect(rewrite("doas pkg_add x")).toBe("doas pkg_add x");
    expect(rewrite("env FOO=bar make")).toBe("env FOO=bar make");
  });

  it("never wraps interpreters (parity with Rust engine exclusion)", () => {
    expect(rewrite("node server.js")).toBe("node server.js");
    expect(rewrite("python3 train.py")).toBe("python3 train.py");
    expect(rewrite("bash deploy.sh")).toBe("bash deploy.sh");
    expect(rewrite("ruby app.rb")).toBe("ruby app.rb");
    expect(rewrite("deno run main.ts")).toBe("deno run main.ts");
  });

  it("never wraps interpreters given by absolute path", () => {
    expect(rewrite("/usr/local/bin/node server.js")).toBe("/usr/local/bin/node server.js");
    expect(rewrite("/usr/bin/python3 -m http.server")).toBe("/usr/bin/python3 -m http.server");
  });

  it("still wraps real tools alongside interpreters in a chain", () => {
    expect(rewrite("git status && node build.js")).toBe(
      "tkr-exec git status && node build.js"
    );
  });

  it("never wraps shell keywords or control flow", () => {
    const cmd = "for i in 1 2; do echo $i; done";
    expect(rewrite(cmd)).toBe(cmd);
  });

  it("never wraps while/read loops", () => {
    const cmd = "while read l; do cat $l; done < f";
    expect(rewrite(cmd)).toBe(cmd);
  });

  it("never wraps builtins without binaries", () => {
    expect(rewrite("set -e; make build")).toBe("set -e; tkr-exec make build");
    expect(rewrite("pushd /tmp && ls")).toBe("pushd /tmp && tkr-exec ls");
    expect(rewrite("[[ -f x ]] && cat x")).toBe("[[ -f x ]] && tkr-exec cat x");
  });

  it("never wraps env-assignment prefixes", () => {
    const cmd = "FOO=1 npm test";
    expect(rewrite(cmd)).toBe(cmd);
  });

  it("never wraps segments with stdout redirects", () => {
    const cmd = "npm test > /tmp/out.txt 2>&1";
    expect(rewrite(cmd)).toBe(cmd);
  });

  it("still wraps when > only appears quoted", () => {
    expect(rewrite('git commit -m "a > b"')).toBe('tkr-exec git commit -m "a > b"');
  });

  it("leaves heredocs entirely untouched", () => {
    const cmd = "cat <<EOF\nline one; still heredoc\nEOF";
    expect(rewrite(cmd)).toBe(cmd);
  });

  it("does not re-wrap an already rewritten command", () => {
    const cmd = 'node "/x/dist/bin/tkr-exec.js" git log';
    expect(rewrite(cmd)).toBe(cmd);
  });

  it("does not split && inside double-quoted strings", () => {
    expect(rewrite('git commit -m "feat: A && B"')).toBe(
      'tkr-exec git commit -m "feat: A && B"'
    );
  });

  it("does not split | inside grep pattern in double quotes", () => {
    expect(rewrite('grep -E "foo|bar" file')).toBe(
      'tkr-exec grep -E "foo|bar" file'
    );
  });

  it("does not split inside single quotes", () => {
    expect(rewrite("echo 'a && b' && ls")).toBe(
      "echo 'a && b' && tkr-exec ls"
    );
  });

  it("does not split inside backticks", () => {
    expect(rewrite("echo `date && echo x` ; ls")).toBe(
      "echo `date && echo x` ; tkr-exec ls"
    );
  });

  it("does not split inside $() subshell", () => {
    expect(rewrite("grep foo $(date && uname) && ls")).toBe(
      "tkr-exec grep foo $(date && uname) && tkr-exec ls"
    );
  });

  it("returns original on unbalanced quotes (fail-safe)", () => {
    expect(rewrite("echo 'unclosed && ls")).toBe("echo 'unclosed && ls");
  });

  it("splitTopLevel marks separators correctly", () => {
    const segs = splitTopLevel("a && b | c");
    expect(segs.map((s) => s.kind)).toEqual(["cmd", "sep", "cmd", "sep", "cmd"]);
    expect(segs.map((s) => s.text.trim())).toEqual(["a", "&&", "b", "|", "c"]);
  });

  it("does not split the noclobber-override redirect >|", () => {
    const segs = splitTopLevel("printf foo >| out.txt");
    expect(segs.map((s) => s.kind)).toEqual(["cmd"]);
    expect(segs[0]!.text.trim()).toBe("printf foo >| out.txt");
  });

  it("leaves a >| redirect segment unwrapped (does not corrupt the target)", () => {
    const cmd = "grep foo >| out.txt";
    expect(rewrite(cmd)).toBe(cmd);
  });

  it("treats |& as a single pipe separator with no orphan &", () => {
    const segs = splitTopLevel("cat a |& tee log");
    expect(segs.map((s) => s.kind)).toEqual(["cmd", "sep", "cmd"]);
    expect(segs.map((s) => s.text.trim())).toEqual(["cat a", "|&", "tee log"]);
  });

  it("wraps only the downstream side of a |& pipe, never detaches a job", () => {
    expect(rewrite("cat a |& tee log")).toBe("cat a |& tkr-exec tee log");
  });
});

describe("single-quote backslash is literal (POSIX)", () => {
  it("detects the real redirect after a single-quoted backslash and does not wrap", () => {
    const cmd = "grep 'C:\\' /tmp/f > out.txt";
    expect(rewrite(cmd)).toBe(cmd);
  });

  it("still wraps a single-quoted backslash command without redirect", () => {
    expect(rewrite("grep 'C:\\' /tmp/f")).toBe("tkr-exec grep 'C:\\' /tmp/f");
  });

  it("keeps double-quote backslash escapes working", () => {
    expect(rewrite('grep "\\\\" f')).toBe('tkr-exec grep "\\\\" f');
    expect(rewrite('git commit -m "say \\"hi\\" && bye"')).toBe(
      'tkr-exec git commit -m "say \\"hi\\" && bye"'
    );
  });

  it("never wraps a command with a truly unclosed single quote", () => {
    expect(rewrite("grep 'oops")).toBe("grep 'oops");
  });

  it("flags an unbalanced parse as unsafe rather than rewritable", () => {
    const segs = splitTopLevel("grep 'oops");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe("cmd");
    expect((segs[0] as { unsafe?: boolean }).unsafe).toBe(true);
  });
});

describe("streaming commands are never wrapped (buffer-until-exit would stall them)", () => {
  it("leaves tail -f and follow logs untouched", () => {
    expect(rewrite("tail -f app.log")).toBe("tail -f app.log");
    expect(rewrite("tail -100f app.log")).toBe("tail -100f app.log");
    expect(rewrite("docker logs -f web")).toBe("docker logs -f web");
    expect(rewrite("kubectl logs --follow pod/web")).toBe("kubectl logs --follow pod/web");
    expect(rewrite("journalctl -f -u tokmizer")).toBe("journalctl -f -u tokmizer");
  });

  it("leaves stern untouched (it streams by default, no flag needed)", () => {
    expect(rewrite("stern web")).toBe("stern web");
    expect(rewrite("stern -n default web")).toBe("stern -n default web");
  });

  it("still wraps the non-streaming variants", () => {
    expect(rewrite("tail -n 50 app.log")).toContain("tkr-exec tail -n 50 app.log");
    expect(rewrite("docker logs web")).toContain("tkr-exec docker logs web");
    expect(rewrite("docker build -f Dockerfile .")).toContain("tkr-exec docker build -f Dockerfile .");
  });
});

describe("buildPreToolUseOutput", () => {
  const payload = (tool_input: Record<string, unknown>) => ({ tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "s-pre", tool_input });

  it("keeps the Claude Code shape without granting any permission", () => {
    const out = JSON.parse(buildPreToolUseOutput(payload({ command: "git log -n 5" }), "claude-code", "tkr-exec")!);
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.updatedInput.command).toContain("tkr-exec");
  });

  it("answers Codex with allow and keeps its other input fields", () => {
    const out = JSON.parse(buildPreToolUseOutput(payload({ command: "git log -n 5", workdir: "/w", timeout_ms: 5000 }), "codex", "tkr-exec")!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput.workdir).toBe("/w");
    expect(out.hookSpecificOutput.updatedInput.timeout_ms).toBe(5000);
    expect(out.hookSpecificOutput.updatedInput.command).toContain("tkr-exec");
  });

  it("never rewrites a Codex command that asks to leave the sandbox", () => {
    for (const extra of [{ sandbox_permissions: "require_escalated" }, { with_escalated_permissions: true }, { justification: "needs network" }, { some_future_field: 1 }]) {
      expect(buildPreToolUseOutput(payload({ command: "git push", ...extra }), "codex", "tkr-exec")).toBeNull();
    }
  });

  it("returns nothing when there is nothing to wrap", () => {
    expect(buildPreToolUseOutput(payload({ command: "cd /x" }), "codex", "tkr-exec")).toBeNull();
    expect(buildPreToolUseOutput({ tool_name: "Read", tool_input: { command: "git log" } }, "codex", "tkr-exec")).toBeNull();
  });
});

describe("Codex rewrite is limited to read-only commands", () => {
  const p = (command: string) => ({ tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "s-ro", tool_input: { command } });

  it.each(["./cat file", "/tmp/ls file", "sort -ro out in", "find . -de\\\nlete", "rg -nz text", "yq -Pi .a=1 file", "cat $DYNAMIC_ARGUMENTS"])("does not rewrite ambiguous or mutating command %s", (cmd) => {
    expect(buildPreToolUseOutput(p(cmd), "codex", "tkr-exec")).toBeNull();
  });

  it("wraps read-only commands, alone or after cd", () => {
    const bin = mkdtempSync(join(tmpdir(), "tkr-ro-bin-"));
    for (const name of ["git", "grep", "cat", "rg", "sort"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\n");
      chmodSync(join(bin, name), 0o755);
    }
    try {
      for (const c of ["git log -n 30", "cd /repo && git diff HEAD~1", "grep -rn foo src", "cat a.md", "rg -n foo src", "git log | sort"]) {
        expect(buildPreToolUseOutput(p(c), "codex", "tkr-exec", () => {}, {}, bin), c).not.toBeNull();
      }
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("leaves any command that can change things to Codex's own rules", () => {
    for (const c of ["git push origin main", "git log && git push", "rm -rf build", "git branch -D x", "cat a > b && git log", "sed -i s/a/b/ f", "curl -X POST https://x", "cat a 1>out", "git log >> x", "find . -name '*.tmp' -delete", "find . -exec rm {} ;", "sort -o f f", "npm test", "npx vitest run x", "pytest", "rg --pre ./x foo", "rg -z foo", "yq -i .a=1 f.yml", "git log --output=x", "git diff --ext-diff", "git -c core.pager=x log", "GIT_EXTERNAL_DIFF=./x git diff", "sort --compress-program=./x f", "tree -o out", "uniq a b", "cat $(rm -rf x)", "cat `rm -rf x`", "grep x \"$(touch y)\"", "git log --format=%H $(touch z)", "file -C -m magic", "yq -s '.a' f.yml", "rg '--pre=./x' foo", "rg \"--pre\" ./x foo", "find . -ex''ec rm {} +", "find . \\-delete", "git \"--output=x\" log", "g\\it push", "'git' push", "tree -R -H . ."]) {
      expect(buildPreToolUseOutput(p(c), "codex", "tkr-exec"), c).toBeNull();
    }
  });

  it("does not restrict Claude Code, which never grants a permission", () => {
    expect(buildPreToolUseOutput(p("git log && git push"), "claude-code", "tkr-exec")).not.toBeNull();
  });
});

describe("Codex rewrite respects the user's Codex rules", () => {
  const p = (command: string) => ({ tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "s-rules", tool_input: { command } });
  const withRules = (rules: string, run: (bin: string) => void): void => {
    const home = mkdtempSync(join(tmpdir(), "tkr-codex-home-"));
    const bin = mkdtempSync(join(tmpdir(), "tkr-codex-bin-"));
    for (const name of ["jq", "rg", "git", "cat"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\n");
      chmodSync(join(bin, name), 0o755);
    }
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      if (rules) {
        mkdirSync(join(home, "rules"));
        writeFileSync(join(home, "rules", "default.rules"), rules);
      }
      run(bin);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  };

  it("does not approve a command a prompt or forbidden rule covers", () => {
    const rules = [
      "prefix_rule(",
      "    pattern = [\"jq\"],",
      "    decision = \"prompt\",",
      "    justification = \"jq can read the environment\",",
      "    match = [\"jq -n env\", [\"jq\", \".a\"]],  # examples",
      "    not_match = [],",
      ")",
      "prefix_rule(pattern=[\"git\", [\"log\", \"show\"]], decision=\"forbidden\")",
      "prefix_rule(pattern=[\"cat\"])"
    ].join("\n");
    withRules(rules, (bin) => {
      for (const c of ["jq -n env", "cd /x && jq .a f.json", "git show HEAD", "git log -n 3"]) {
        expect(buildPreToolUseOutput(p(c), "codex", "tkr-exec", () => {}, {}, bin), c).toBeNull();
      }
      for (const c of ["cat a.md", "git diff", "rg -n foo src"]) {
        expect(buildPreToolUseOutput(p(c), "codex", "tkr-exec", () => {}, {}, bin), c).not.toBeNull();
      }
    });
  });

  it("does not approve anything when a rules file cannot be understood", () => {
    withRules("prefix_rule(pattern=GIT_PATTERN, decision=\"prompt\")", (bin) => {
      expect(buildPreToolUseOutput(p("cat a.md"), "codex", "tkr-exec", () => {}, {}, bin)).toBeNull();
    });
  });

  it("does not approve rg with an external host name program", () => {
    withRules("", (bin) => {
      for (const c of ["rg --hostname-bin=x pattern", "rg --hostname-bin x pattern", "rg --pre=x pattern"]) {
        expect(buildPreToolUseOutput(p(c), "codex", "tkr-exec", () => {}, {}, bin), c).toBeNull();
      }
      expect(buildPreToolUseOutput(p("jq -n env"), "codex", "tkr-exec", () => {}, {}, bin)).not.toBeNull();
    });
  });
});
