import { describe, expect, it } from "vitest";
import { routingCandidates, normalizeHead, lastSegment } from "../engine/routing";

describe("normalizeHead", () => {
  it("strips leading env assignments", () => {
    expect(normalizeHead("NODE_ENV=test FOO=1 git log")).toBe("git log");
  });

  it("strips sudo/time/command wrappers", () => {
    expect(normalizeHead("sudo docker ps")).toBe("docker ps");
    expect(normalizeHead("time git status")).toBe("git status");
    expect(normalizeHead("command git log")).toBe("git log");
  });

  it("strips timeout with its duration argument", () => {
    expect(normalizeHead("timeout 30 git log")).toBe("git log");
  });

  it("reduces an absolute path head to its basename", () => {
    expect(normalizeHead("/usr/bin/grep -rn foo src/")).toBe("grep -rn foo src/");
  });

  it("leaves a plain command untouched", () => {
    expect(normalizeHead("git log --oneline")).toBe("git log --oneline");
  });

  it("returns input when only assignments remain", () => {
    expect(normalizeHead("FOO=bar")).toBe("FOO=bar");
  });
});

describe("lastSegment", () => {
  it("returns the last pipe segment", () => {
    expect(lastSegment("git log | grep foo")).toBe("grep foo");
  });

  it("returns the last segment across && and ;", () => {
    expect(lastSegment("cd x && git log")).toBe("git log");
    expect(lastSegment("a; b; git status")).toBe("git status");
  });

  it("does not split on | inside quotes", () => {
    expect(lastSegment('grep -E "foo|bar" file')).toBe('grep -E "foo|bar" file');
    expect(lastSegment("grep 'a|b' f | head -3")).toBe("head -3");
  });

  it("returns the whole command when no separator", () => {
    expect(lastSegment("git log")).toBe("git log");
  });
});

describe("routingCandidates", () => {
  it("bash-tool synthetic: tries the inner command before the synthetic", () => {
    expect(routingCandidates("bash-tool: grep -rn foo src/")).toEqual([
      "grep -rn foo src/",
      "bash-tool: grep -rn foo src/"
    ]);
  });

  it("bash-tool with pipe: tries the producing (last) segment first", () => {
    expect(routingCandidates("bash-tool: git log | grep foo")).toEqual([
      "grep foo",
      "bash-tool: git log | grep foo"
    ]);
  });

  it("bash-tool with env prefix and abs path: normalized candidate", () => {
    expect(routingCandidates("bash-tool: FOO=1 /usr/bin/grep x f")).toEqual([
      "grep x f",
      "bash-tool: FOO=1 /usr/bin/grep x f"
    ]);
  });

  it("read/grep/glob-tool synthetics stay as-is", () => {
    expect(routingCandidates("read-tool: read /a/b.ts")).toEqual(["read-tool: read /a/b.ts"]);
    expect(routingCandidates("grep-tool: grep foo")).toEqual(["grep-tool: grep foo"]);
  });

  it("plain command (exec path): normalization applies, no duplicate", () => {
    expect(routingCandidates("git log")).toEqual(["git log"]);
    expect(routingCandidates("sudo docker ps")).toEqual(["docker ps", "sudo docker ps"]);
  });
});

describe("routingCandidates on command lists (&& ; ||)", () => {
  it("does not route by a trailing echo when an earlier segment produces output", () => {
    const cmd = "bash-tool: node build.js && echo BUILD OK";
    expect(routingCandidates(cmd)).toEqual([cmd]);
  });

  it("routes by the last segment when every earlier segment is quiet", () => {
    expect(routingCandidates("bash-tool: cd app && npm test")).toEqual([
      "npm test",
      "bash-tool: cd app && npm test"
    ]);
    expect(routingCandidates("bash-tool: mkdir -p x && cd x && cargo build")).toEqual([
      "cargo build",
      "bash-tool: mkdir -p x && cd x && cargo build"
    ]);
  });

  it("tolerates a quiet echo before the producing segment", () => {
    expect(routingCandidates("bash-tool: echo start && npm test")).toEqual([
      "npm test",
      "bash-tool: echo start && npm test"
    ]);
  });

  it("does not route by the tail of a semicolon list with noisy segments", () => {
    const cmd = "bash-tool: cat big.log; echo done";
    expect(routingCandidates(cmd)).toEqual([cmd]);
  });

  it("still routes pure pipes by the producing tail segment", () => {
    expect(routingCandidates("bash-tool: git log | head -200")).toEqual([
      "head -200",
      "bash-tool: git log | head -200"
    ]);
  });
});

describe("quoting edge cases", () => {
  it("does not split on | after an escaped quote inside a double-quoted string", () => {
    const cmd = 'grep "a\\"|b" src/x.ts';
    expect(lastSegment(cmd)).toBe(cmd);
    expect(routingCandidates(`bash-tool: ${cmd}`)).toEqual([cmd, `bash-tool: ${cmd}`]);
  });

  it("never produces a garbage candidate for a bare bash-tool synthetic", () => {
    expect(routingCandidates("bash-tool")).toEqual(["bash-tool"]);
    expect(routingCandidates("bash-tool:")).toEqual(["bash-tool:"]);
  });
});
