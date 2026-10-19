import { describe, expect, it } from "vitest";
import { rememberOutput, forgetSession, repeatNotice } from "../repeat-guard";

const big = (tag: string): string => `${tag}\n${"x".repeat(2000)}`;

describe("rememberOutput", () => {
  it("returns null the first time and the earlier command on an identical repeat", () => {
    const s = `rg-${Date.now()}-a`;
    expect(rememberOutput(s, "main", big("one"), "cat a.md")).toBeNull();
    expect(rememberOutput(s, "main", big("one"), "awk '{print}' a.md")).toEqual({ cmd: "cat a.md" });
  });

  it("keeps agents apart so a subagent never gets a stub for what only the parent saw", () => {
    const s = `rg-${Date.now()}-b`;
    expect(rememberOutput(s, "main", big("two"), "cat b.md")).toBeNull();
    expect(rememberOutput(s, "agent-123", big("two"), "cat b.md")).toBeNull();
    expect(rememberOutput(s, "agent-123", big("two"), "cat b.md")).toEqual({ cmd: "cat b.md" });
  });

  it("treats any change in the output as new", () => {
    const s = `rg-${Date.now()}-c`;
    expect(rememberOutput(s, "main", big("three"), "git status")).toBeNull();
    expect(rememberOutput(s, "main", big("three!"), "git status")).toBeNull();
  });

  it("forgets everything for a session after a compaction", () => {
    const s = `rg-${Date.now()}-d`;
    rememberOutput(s, "main", big("four"), "cat d.md");
    forgetSession(s);
    expect(rememberOutput(s, "main", big("four"), "cat d.md")).toBeNull();
  });

  it("keeps tabs and newlines of the command out of the record", () => {
    const s = `rg-${Date.now()}-e`;
    rememberOutput(s, "main", big("five"), "cat\te.md\nnext");
    expect(rememberOutput(s, "main", big("five"), "x")).toEqual({ cmd: "cat e.md next" });
  });
});

describe("repeatNotice", () => {
  it("names the earlier command and stays short", () => {
    const n = repeatNotice("npm test", 4123);
    expect(n).toContain("npm test");
    expect(n.length).toBeLessThan(200);
  });
});

describe("rememberOutput and secrets", () => {
  it("never writes a secret from the command into the seen file", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const s = `rg-${Date.now()}-secret`;
    rememberOutput(s, "main", big("sec"), "curl -H 'Authorization: Bearer abcdefghijklmnop123456' https://x");
    const seen = readFileSync(join(process.env.TOKMIZER_HOME!, "sessions", `${s}.seen`), "utf8");
    expect(seen).not.toContain("abcdefghijklmnop123456");
  });
});
