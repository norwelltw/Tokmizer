import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanAgentUsage, type UsageSource } from "../agent-usage";
import { estimateCostUsd } from "../model-prices";
import { renderUsage, summarizeUsage } from "../usage-report";
import { shareableModel, syncPayloadRows } from "../agent-usage-sync";

let dir: string;
let claudeRoot: string;
let codexRoot: string;
let sources: UsageSource[];

const ts = "2026-11-03T12:00:00.000Z";
const day = (() => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

function claudeMsg(id: string, req: string, usage: Record<string, unknown>, model = "claude-opus-5-5"): string {
  return JSON.stringify({ type: "assistant", timestamp: ts, requestId: req, message: { id, model, usage } }) + "\n";
}

function codexTurn(model: string): string {
  return JSON.stringify({ timestamp: ts, type: "turn_context", payload: { model } }) + "\n";
}

function codexCount(input: number, cached: number, output: number): string {
  return JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, cache_write_input_tokens: 0, total_tokens: input + output } } } }) + "\n";
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-agent-usage-"));
  claudeRoot = join(dir, "claude", "projects");
  codexRoot = join(dir, "codex", "sessions");
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  sources = [{ agent: "claude-code", root: claudeRoot }, { agent: "codex", root: codexRoot }];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const scan = () => scanAgentUsage({ sources, cacheFile: join(dir, "cache.json") });

describe("scanAgentUsage", () => {
  it("counts Claude Code messages once even when the log repeats them", () => {
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 } };
    mkdirSync(join(claudeRoot, "p"), { recursive: true });
    writeFileSync(join(claudeRoot, "p", "s.jsonl"), claudeMsg("m1", "r1", usage) + claudeMsg("m1", "r1", usage) + claudeMsg("m2", "r2", usage));
    const rows = scan();
    expect(rows).toEqual([{ day, agent: "claude-code", model: "claude-opus-5-5", input: 20, output: 40, cacheRead: 600, cacheWrite: 0, cacheWrite1h: 80, requests: 2 }]);
  });

  it("reads subagent logs nested deep under a session", () => {
    const nested = join(claudeRoot, "p", "session", "subagents", "workflows", "wf_1");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "agent-a.jsonl"), claudeMsg("m9", "r9", { input_tokens: 5, output_tokens: 5 }, "claude-sonnet-5-5"));
    expect(scan().map((r) => r.model)).toEqual(["claude-sonnet-5-5"]);
  });

  it("skips synthetic Claude entries and broken lines", () => {
    mkdirSync(join(claudeRoot, "p"), { recursive: true });
    writeFileSync(join(claudeRoot, "p", "s.jsonl"), claudeMsg("m1", "r1", { input_tokens: 1, output_tokens: 1 }, "<synthetic>") + '{"type":"assistant","usage"\n');
    expect(scan()).toEqual([]);
  });

  it("only reads what was appended since the last run, and waits for a full line", () => {
    mkdirSync(join(claudeRoot, "p"), { recursive: true });
    const file = join(claudeRoot, "p", "s.jsonl");
    const line = claudeMsg("m1", "r1", { input_tokens: 1, output_tokens: 2 });
    writeFileSync(file, line + line.slice(0, 30));
    expect(scan()[0]?.requests).toBe(1);
    appendFileSync(file, line.slice(30).replace('"m1"', '"m1"'));
    expect(scan()[0]?.requests).toBe(1);
    appendFileSync(file, claudeMsg("m3", "r3", { input_tokens: 1, output_tokens: 2 }));
    expect(scan()[0]?.requests).toBe(2);
  });

  it("keeps an accented character split across reads intact", () => {
    mkdirSync(join(claudeRoot, "p"), { recursive: true });
    const file = join(claudeRoot, "p", "s.jsonl");
    const filler = JSON.stringify({ type: "user", text: "é".repeat(3 * 1024 * 1024) }) + "\n";
    writeFileSync(file, filler + claudeMsg("m1", "r1", { input_tokens: 7, output_tokens: 3 }));
    expect(scan()[0]?.input).toBe(7);
    appendFileSync(file, claudeMsg("m2", "r2", { input_tokens: 7, output_tokens: 3 }));
    expect(scan()[0]?.requests).toBe(2);
  });

  it("turns Codex running totals into per-turn usage and ignores the totals carried over by a resumed session", () => {
    const d = join(codexRoot, "2026", "11", "03");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "rollout-a.jsonl"), [
      codexCount(5000, 4000, 100),
      codexTurn("gpt-6-sol"),
      codexCount(6000, 4500, 150),
      codexCount(6000, 4500, 150),
      codexCount(7000, 5000, 200),
      codexCount(300, 0, 10)
    ].join(""));
    expect(scan()).toEqual([{ day, agent: "codex", model: "gpt-6-sol", input: 1000 + 300, output: 100 + 10, cacheRead: 1000, cacheWrite: 0, cacheWrite1h: 0, requests: 3 }]);
  });

  it("ignores Codex files that are not session rollouts", () => {
    writeFileSync(join(codexRoot, "history.jsonl"), codexTurn("gpt-6-sol") + codexCount(10, 0, 10));
    expect(scan()).toEqual([]);
  });

  it("keeps the history of a log file that was deleted", () => {
    mkdirSync(join(claudeRoot, "p"), { recursive: true });
    const file = join(claudeRoot, "p", "s.jsonl");
    writeFileSync(file, claudeMsg("m1", "r1", { input_tokens: 1, output_tokens: 1 }));
    expect(scan()).toHaveLength(1);
    rmSync(file);
    expect(scan()).toHaveLength(1);
  });
});

describe("estimateCostUsd", () => {
  const t = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000, requests: 1 };

  it("prices Claude models with cache reads and both cache write durations", () => {
    expect(estimateCostUsd("claude-opus-5-5", t)).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 6);
    expect(estimateCostUsd("claude-sonnet-4-5-20250929", t)).toBeCloseTo(3 + 15 + 0.3 + 3.75 + 6, 6);
  });

  it("prices OpenAI models and does not guess unknown ones", () => {
    expect(estimateCostUsd("gpt-6-astra", { ...t, cacheWrite: 0, cacheWrite1h: 0 })).toBeCloseTo(10 + 50 + 1, 6);
    expect(estimateCostUsd("gpt-6-astra-pro", t)).toBeNull();
    expect(estimateCostUsd("codex-auto-review", t)).toBeNull();
    expect(estimateCostUsd("claude-opus-4-1-20250805", { ...t, cacheWrite: 0, cacheWrite1h: 0 })).toBeCloseTo(15 + 75 + 1.5, 6);
  });
});

describe("syncPayloadRows", () => {
  it("sends only token counts per day, agent and model, over the last 90 days", () => {
    const base = { agent: "claude-code" as const, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 10, cacheWrite1h: 5, requests: 3 };
    const recent = new Date();
    const today = `${recent.getFullYear()}-${String(recent.getMonth() + 1).padStart(2, "0")}-${String(recent.getDate()).padStart(2, "0")}`;
    const out = syncPayloadRows([
      { ...base, day: today, model: "claude-opus-5-5" },
      { ...base, day: "2020-01-01", model: "claude-opus-5-5" }
    ]);
    expect(out).toEqual([{ date: today, agent: "claude-code", model: "claude-opus-5-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 15, requests: 3, costUsd: 4.0001 }]);
  });
});

describe("shareableModel", () => {
  it("never sends a cloud resource name or an odd string as the model", () => {
    expect(shareableModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(shareableModel("openai/gpt-6-sol")).toBe("gpt-6-sol");
    expect(shareableModel("arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-opus-5-5")).toBe("other");
    expect(shareableModel("my secret model")).toBe("other");
  });
});

describe("renderUsage", () => {
  it("marks a cost as partial when a model has no price", () => {
    const out = renderUsage(summarizeUsage([
      { day, agent: "codex", model: "gpt-6-sol", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, requests: 1 },
      { day, agent: "codex", model: "codex-auto-review", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, requests: 1 }
    ]), { color: false, subtitle: "test" });
    expect(out).toContain("$2.00+ estimated");
    expect(out).toContain("no price");
    expect(out).toContain("A + means");
  });

  it("explains an empty period", () => {
    expect(renderUsage(summarizeUsage([]), { color: false, subtitle: "test" })).toContain("No agent usage found");
  });
});

describe("tkr usage", () => {
  function run(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("packages/plugin/src/bin/tkr.ts"), "usage", ...args], {
      encoding: "utf8",
      input: "",
      timeout: 20000,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        HOME: dir,
        CLAUDE_CONFIG_DIR: join(dir, "claude"),
        CODEX_HOME: join(dir, "codex"),
        TOKMIZER_HOME: join(dir, "tkr"),
        TOKMIZER_BASE_URL: "http://127.0.0.1:1",
        TOKMIZER_AUTO_UPDATE: "0",
        TOKMIZER_DAEMON_BIN: join(dir, "disabled-daemon.js"),
        TOKMIZER_CLAUDE_COMMANDS_DIR: join(dir, "commands"),
        XDG_RUNTIME_DIR: ""
      }
    });
  }

  it("prints JSON for the logs found on the machine", () => {
    mkdirSync(join(claudeRoot, "p"), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(claudeRoot, "p", "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: now, requestId: "r", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } } }) + "\n");
    const r = run("--json");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.totals).toMatchObject({ input: 1_000_000, requests: 1, costUsd: 4, costComplete: true });
    expect(out.byAgent[0].agent).toBe("claude-code");
  });

  it("filters one agent and rejects unknown flags", () => {
    expect(run("--codex").stdout).toContain("No agent usage found");
    const bad = run("--nope");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Usage: tkr usage");
  });
});
