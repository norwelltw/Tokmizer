import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordSessionEvent,
  readSessionEvents,
  buildSessionRecap,
  pruneSessions,
  sessionFile
} from "../session-log";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-sess-"));
  process.env.TOKMIZER_HOME = home;
});

describe("session event log", () => {
  it("appends and reads back events for a session", () => {
    recordSessionEvent("abc-123", { tool: "Read", target: "/src/app.ts" });
    recordSessionEvent("abc-123", { tool: "Bash", target: "npm test", fail: 1 });
    const events = readSessionEvents("abc-123");
    expect(events.length).toBe(2);
    expect(events[0]!.target).toBe("/src/app.ts");
    expect(events[1]!.fail).toBe(1);
  });

  it("sanitizes hostile session ids into safe filenames", () => {
    recordSessionEvent("../../etc/passwd", { tool: "Read", target: "/x" });
    expect(sessionFile("../../etc/passwd")).not.toContain("..");
    expect(existsSync(join(home, "sessions"))).toBe(true);
  });

  it("caps a runaway session file", () => {
    for (let i = 0; i < 900; i++) {
      recordSessionEvent("big", { tool: "Bash", target: `cmd ${i} ${"x".repeat(120)}` });
    }
    const lines = readFileSync(sessionFile("big"), "utf8").split("\n").filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(600);
    expect(lines[lines.length - 1]).toContain("cmd 899");
  });

  it("prunes session files older than the retention window", () => {
    recordSessionEvent("old-one", { tool: "Read", target: "/a" });
    const f = sessionFile("old-one");
    const past = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(f, past, past);
    recordSessionEvent("fresh", { tool: "Read", target: "/b" });
    pruneSessions();
    expect(existsSync(f)).toBe(false);
    expect(existsSync(sessionFile("fresh"))).toBe(true);
  });
});

describe("buildSessionRecap", () => {
  it("summarizes the working set: files, searches, commands, failures", () => {
    const events = [
      { t: 1, tool: "Read", target: "/src/a.ts" },
      { t: 2, tool: "Read", target: "/src/a.ts" },
      { t: 3, tool: "Read", target: "/src/b.ts" },
      { t: 4, tool: "Grep", target: "handleLogin" },
      { t: 5, tool: "Bash", target: "npm test", fail: 1 as const },
      { t: 6, tool: "Bash", target: "git status" }
    ];
    const recap = buildSessionRecap(events);
    expect(recap).toContain("/src/a.ts");
    expect(recap).toContain("×2");
    expect(recap).toContain("handleLogin");
    expect(recap).toContain("npm test");
    expect(recap).toMatch(/npm test.*(failed|✗)/i);
    expect(recap.split("\n").length).toBeLessThanOrEqual(30);
  });

  it("returns empty for an empty session", () => {
    expect(buildSessionRecap([])).toBe("");
  });

  it("stays within 30 lines even for a huge session", () => {
    const events = Array.from({ length: 400 }, (_, i) => ({
      t: i,
      tool: i % 2 ? "Read" : "Bash",
      target: i % 2 ? `/src/file${i}.ts` : `command-${i} --flag`
    }));
    expect(buildSessionRecap(events).split("\n").length).toBeLessThanOrEqual(30);
  });
});

describe("session recap hook decision", () => {
  it("emits a recap only for compact and resume sources", async () => {
    const { recapForSessionStart } = await import("../hooks-host/session-recap");
    recordSessionEvent("s1", { tool: "Read", target: "/src/z.ts" });
    expect(await recapForSessionStart({ session_id: "s1", source: "compact" })).toContain("/src/z.ts");
    expect(await recapForSessionStart({ session_id: "s1", source: "resume" })).toContain("/src/z.ts");
    expect(await recapForSessionStart({ session_id: "s1", source: "startup" })).toBeNull();
    expect(await recapForSessionStart({ session_id: "s1", source: "clear" })).toBeNull();
    expect(await recapForSessionStart({ session_id: "missing", source: "compact" })).toBeNull();
  });
});

describe("secrets in recorded commands", async () => {
  const { redactTarget } = await import("../session-log");
  const { maskSecrets } = await import("../learn/redact");

  it("masks secrets passed as a separate argument to tools that take them that way", () => {
    for (const [cmd, secret] of [
      ["aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"],
      ["aws configure set aws_session_token FwoGZXIvYXdzEJr", "FwoGZXIvYXdzEJr"],
      ["sshpass -p hunter2 ssh me@host", "hunter2"],
      ["sshpass -e -p hunter2 ssh me@host", "hunter2"],
      ["redis-cli -h db -a hunter2 ping", "hunter2"],
      ["openssl enc -aes-256-cbc -k mypassphrase -in a", "mypassphrase"],
      ["openssl rsa -in k.pem -passin pass:mypassphrase", "mypassphrase"],
      ["mysql -u root -p'Hunter2 Secret' db", "Secret"],
      ['mysql -u root -p"Hunter2 Secret" db', "Secret"],
      ["curl -X POST https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXX"]
    ]) {
      expect(redactTarget(cmd!), cmd).not.toContain(secret);
    }
  });

  it("keeps ordinary flags readable", () => {
    expect(redactTarget("ssh -p 2222 me@host")).toBe("ssh -p 2222 me@host");
    expect(redactTarget("redis-cli -h db ping")).toBe("redis-cli -h db ping");
  });

  it("masks Anthropic and OpenAI project keys in cached outputs", () => {
    const out = maskSecrets("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 and sk-proj-abcdefghijklmnopqrstuvwxyz0123");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });
});
