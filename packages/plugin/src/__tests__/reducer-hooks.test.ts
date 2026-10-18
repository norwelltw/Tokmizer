import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Settings, ReducerLevel } from "../contracts";
import { PLUGIN_VERSION } from "../version";

const here = dirname(fileURLToPath(import.meta.url));
const distHooks = join(here, "..", "..", "dist", "hooks-host");
const sessionStartHook = join(distHooks, "reducer-session-start.js");
const promptSubmitHook = join(distHooks, "reducer-prompt-submit.js");

function runHook(hook: string, home: string, stdin = ""): string {
  return execFileSync(process.execPath, [hook], {
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, TOKMIZER_HOME: home }
  });
}

function writeSettings(home: string, reducer: string): void {
  writeFileSync(
    join(home, "settings-cache.json"),
    JSON.stringify(Settings.parse({ reducer, telemetryOptIn: true }))
  );
}

function writeState(home: string, overrides: Record<string, unknown>): void {
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      token: "t",
      jwt: "j",
      signingSecret: "s",
      plan: "pro",
      status: "active",
      trialEndsAt: null,
      subEndsAt: null,
      jwtVersion: 1,
      installId: "i",
      lastHeartbeatOkAt: Date.now(),
      ...overrides
    })
  );
}

describe("reducer settings schema", () => {
  it("defaults to off", () => {
    expect(Settings.parse({}).reducer).toBe("off");
  });

  it("accepts the four levels", () => {
    for (const level of ["off", "light", "balanced", "max"]) {
      expect(ReducerLevel.parse(level)).toBe(level);
    }
  });

  it("rejects unknown levels", () => {
    expect(() => ReducerLevel.parse("ultra")).toThrow();
  });

  it("old settings without the field parse to off", () => {
    const legacy = { enabled: true, telemetryOptIn: true, outputVerbosity: "compact" };
    expect(Settings.parse(legacy).reducer).toBe("off");
  });
});

describe("reducer hooks (real dist bundles)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tkr-reducer-"));
    mkdirSync(join(home, "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("dist bundles exist", () => {
    expect(existsSync(sessionStartHook)).toBe(true);
    expect(existsSync(promptSubmitHook)).toBe(true);
  });

  it("off: session-start emits nothing", () => {
    writeSettings(home, "off");
    expect(runHook(sessionStartHook, home)).toBe("");
  });

  it("active without cached ruleset: emits nothing", () => {
    writeSettings(home, "balanced");
    expect(runHook(sessionStartHook, home)).toBe("");
  });

  it("active with cached ruleset: emits the ruleset", () => {
    writeSettings(home, "max");
    writeState(home, {});
    writeFileSync(join(home, "skills", "reducer-max.md"), "RULESET MAX BODY");
    expect(runHook(sessionStartHook, home)).toBe("RULESET MAX BODY");
  });

  it("no settings cache at all: emits nothing", () => {
    expect(runHook(sessionStartHook, home)).toBe("");
  });

  it("prompt-submit off: emits nothing", () => {
    writeSettings(home, "off");
    expect(runHook(promptSubmitHook, home, "{}")).toBe("");
  });

  it("prompt-submit active: emits one-line additionalContext, never the ruleset", () => {
    writeSettings(home, "light");
    writeState(home, {});
    writeFileSync(join(home, "skills", "reducer-light.md"), "FULL RULESET CONTENT");
    const out = runHook(promptSubmitHook, home, "{}");
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("TKR REDUCER ACTIVE (light)");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("FULL RULESET CONTENT");
  });

  it("prompt-submit additionalContext is KV-cache-stable: byte-identical across turns, no volatile tokens", () => {
    for (const level of ["light", "balanced", "max"]) {
      writeSettings(home, level);
      writeState(home, {});
      writeFileSync(join(home, "skills", `reducer-${level}.md`), "RULESET");
      const first = runHook(promptSubmitHook, home, "{}");
      const second = runHook(promptSubmitHook, home, "{}");
      expect(first).toBe(second);
      const ctx = JSON.parse(first).hookSpecificOutput.additionalContext as string;
      expect(ctx).not.toMatch(/\d/);
    }
  });

  it("prompt-submit active without cached ruleset: emits nothing", () => {
    writeSettings(home, "light");
    expect(runHook(promptSubmitHook, home, "{}")).toBe("");
  });

  it("free plan: session-start still emits the ruleset (no plan gating)", () => {
    writeSettings(home, "max");
    writeState(home, { plan: "free", bonusActive: false });
    writeFileSync(join(home, "skills", "reducer-max.md"), "RULESET MAX BODY");
    expect(runHook(sessionStartHook, home)).toBe("RULESET MAX BODY");
  });

  it("stale heartbeat: session-start still emits the ruleset (no grace gating)", () => {
    writeSettings(home, "max");
    writeState(home, { plan: "pro", lastHeartbeatOkAt: 1 });
    writeFileSync(join(home, "skills", "reducer-max.md"), "RULESET MAX BODY");
    expect(runHook(sessionStartHook, home)).toBe("RULESET MAX BODY");
  });

  it("free plan: prompt-submit still announces the reducer (no plan gating)", () => {
    writeSettings(home, "light");
    writeState(home, { plan: "free", bonusActive: false });
    writeFileSync(join(home, "skills", "reducer-light.md"), "FULL RULESET CONTENT");
    const parsed = JSON.parse(runHook(promptSubmitHook, home, "{}"));
    expect(parsed.hookSpecificOutput.additionalContext).toContain("TKR REDUCER ACTIVE (light)");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("FULL RULESET CONTENT");
  });

  it("free with active bonus: session-start still emits the ruleset", () => {
    writeSettings(home, "max");
    writeState(home, { plan: "free", bonusActive: true });
    writeFileSync(join(home, "skills", "reducer-max.md"), "RULESET MAX BODY");
    expect(runHook(sessionStartHook, home)).toBe("RULESET MAX BODY");
  });
});

describe("reducer stop hook (real dist bundle)", () => {
  let home: string;
  const stopHook = join(distHooks, "reducer-stop.js");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tkr-reducer-stop-"));
    mkdirSync(join(home, "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeTranscript(textLen: number): string {
    const p = join(home, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "A".repeat(textLen) }] } })
    ];
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  function spool(): string | null {
    try {
      return require("node:fs").readFileSync(join(home, "spool", "telemetry.jsonl"), "utf8");
    } catch {
      return null;
    }
  }

  function statsFile(): string | null {
    try {
      return require("node:fs").readFileSync(join(home, "stats.jsonl"), "utf8");
    } catch {
      return null;
    }
  }

  it("active: credits savings in local stats as a modeled entry", () => {
    writeSettings(home, "max");
    writeState(home, {});
    writeFileSync(join(home, "skills", "reducer-max.md"), "RULESET");
    const t = writeTranscript(4000);
    runHook(stopHook, home, JSON.stringify({ transcript_path: t }));
    const s = statsFile();
    expect(s).toBeTruthy();
    const rec = JSON.parse(s!.trim().split("\n").pop()!);
    expect(rec.m).toBe(1);
    expect(rec.r - rec.f).toBe(2000 * 4);
  });

  it("off: writes no local stats", () => {
    writeSettings(home, "off");
    const t = writeTranscript(4000);
    runHook(stopHook, home, JSON.stringify({ transcript_path: t }));
    expect(statsFile()).toBeNull();
  });

  it("active: records estimated reducer savings to telemetry spool", () => {
    writeSettings(home, "max");
    writeState(home, {});
    writeFileSync(join(home, "skills", "reducer-max.md"), "RULESET");
    const t = writeTranscript(4000);
    runHook(stopHook, home, JSON.stringify({ transcript_path: t }));
    const s = spool();
    expect(s).toBeTruthy();
    const rec = JSON.parse(s!.trim().split("\n").pop()!);
    expect(rec.cmd).toBe("reducer");
    expect(rec.optimized).toBe(true);
    expect(rec.tokensSaved).toBe(2000);
  });

  it("off: records nothing", () => {
    writeSettings(home, "off");
    const t = writeTranscript(4000);
    runHook(stopHook, home, JSON.stringify({ transcript_path: t }));
    expect(spool()).toBeNull();
  });

  it("active without cached ruleset: records nothing", () => {
    writeSettings(home, "balanced");
    const t = writeTranscript(4000);
    runHook(stopHook, home, JSON.stringify({ transcript_path: t }));
    expect(spool()).toBeNull();
  });

  it("tiny reply below threshold: records nothing", () => {
    writeSettings(home, "light");
    writeFileSync(join(home, "skills", "reducer-light.md"), "RULESET");
    const t = writeTranscript(20);
    runHook(stopHook, home, JSON.stringify({ transcript_path: t }));
    expect(spool()).toBeNull();
  });

  it("free plan: still records savings (no plan gating)", () => {
    writeSettings(home, "max");
    writeState(home, { plan: "free", bonusActive: false });
    writeFileSync(join(home, "skills", "reducer-max.md"), "RULESET");
    const t = writeTranscript(4000);
    runHook(stopHook, home, JSON.stringify({ transcript_path: t }));
    const s = spool();
    expect(s).toBeTruthy();
    expect(JSON.parse(s!.trim().split("\n").pop()!).cmd).toBe("reducer");
    expect(statsFile()).not.toBeNull();
  });

  it("stale heartbeat: still records savings (no grace gating)", () => {
    writeSettings(home, "max");
    writeState(home, { plan: "pro", lastHeartbeatOkAt: 1 });
    writeFileSync(join(home, "skills", "reducer-max.md"), "RULESET");
    const t = writeTranscript(4000);
    runHook(stopHook, home, JSON.stringify({ transcript_path: t }));
    const s = spool();
    expect(s).toBeTruthy();
    expect(JSON.parse(s!.trim().split("\n").pop()!).cmd).toBe("reducer");
    expect(statsFile()).not.toBeNull();
  });
});

describe("post-tool-use hook (real dist bundle)", () => {
  const postToolUseHook = join(distHooks, "post-tool-use.js");
  let home: string;
  let daemon: Server;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "tkr-ptu-"));
    mkdirSync(join(home, "run"), { recursive: true });
    daemon = createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          const msg = JSON.parse(line) as { id: string; op: string };
          if (msg.op === "ping") {
            sock.write(JSON.stringify({ id: msg.id, ok: true, data: { pid: 1, uptimeMs: 1, ruleCount: 1, bundleVersion: 1, version: PLUGIN_VERSION } }) + "\n");
            continue;
          }
          const filter =
            msg.op === "filter"
              ? { slug: "read-tool", match_command: "^read-tool:", priority: 70, transform: "smart-read", max_lines: 400, scale_with_level: false }
              : null;
          sock.write(JSON.stringify({ id: msg.id, ok: true, data: { filter, cacheHit: true } }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => daemon.listen(join(home, "run", "daemon.sock"), resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => daemon.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });

  function runPostToolUse(stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [postToolUseHook],
        { encoding: "utf8", env: { ...process.env, TOKMIZER_HOME: home, XDG_RUNTIME_DIR: "" } },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
      child.stdin!.end(stdin);
    });
  }

  it("dist bundle exists", () => {
    expect(existsSync(postToolUseHook)).toBe(true);
  });

  it("emits the updatedToolOutput envelope for a real Read tool_response shape", async () => {
    writeFileSync(join(home, "settings-cache.json"), JSON.stringify(Settings.parse({})));
    writeState(home, {});
    const content = Array.from(
      { length: 600 },
      (_, i) => `export function generated${i}(a: number, b: number): number {\n  const sum = a + b;\n  return sum * ${i};\n}`
    ).join("\n");
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/tmp/generated-big.ts" },
      tool_response: { type: "text", file: { content } }
    });
    const out = await runPostToolUse(payload);
    expect(out).not.toBe("");
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { hookEventName: string; updatedToolOutput?: { file?: { content?: string } } };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput).toHaveProperty("updatedToolOutput");
    const updated = parsed.hookSpecificOutput.updatedToolOutput!;
    expect(updated.file?.content).toBeTruthy();
    expect(updated.file!.content!.length).toBeLessThan(content.length);
  });

  it("emits nothing for an un-covered tool", async () => {
    writeFileSync(join(home, "settings-cache.json"), JSON.stringify(Settings.parse({})));
    writeState(home, {});
    const payload = JSON.stringify({ tool_name: "WebFetch", tool_response: "x".repeat(5000) });
    expect(await runPostToolUse(payload)).toBe("");
  });
});
