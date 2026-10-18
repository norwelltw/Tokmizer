import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const plugin = resolve(__dirname, "../..");
const bench = join(plugin, "bench");
type Case = { id: string; command: string; exit: number; file?: string; generate?: string; stream?: string };
const cases = (JSON.parse(readFileSync(join(bench, "corpus.json"), "utf8")) as { cases: Case[] }).cases;
const PUBLIC_AUDIT = new Set(["cargo.txt", "gcloud.txt", "next.txt", "pytest.txt", "terraform.txt"]);
const PRIVATE_MARKER = /\/Users\/|tokmizer|norwell|Documents\/Token/i;

describe("benchmark corpus", () => {
  it("lists unique cases with a command, an exit code and one source", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.command.trim().length, c.id).toBeGreaterThan(0);
      expect(Number.isInteger(c.exit), c.id).toBe(true);
      expect(Boolean(c.file) !== Boolean(c.generate), c.id).toBe(true);
      if (c.stream) expect(c.stream).toBe("stderr");
    }
  });

  it("uses only fixtures published with the plugin and never monorepo captures", () => {
    for (const c of cases.filter((item) => item.file)) {
      expect(c.file!.startsWith("src/__tests__/fixtures/"), c.id).toBe(true);
      expect(existsSync(join(plugin, c.file!)), c.id).toBe(true);
      expect(c.file!.includes("/list/"), c.id).toBe(false);
      if (c.file!.includes("/audit/")) expect(PUBLIC_AUDIT.has(c.file!.split("/").pop()!), c.id).toBe(true);
    }
  });

  it("generates synthetic outputs without private markers", async () => {
    const { GENERATORS } = await import(join(bench, "synthetic.mjs"));
    for (const c of cases.filter((item) => item.generate)) {
      const text = GENERATORS[c.generate!]() as string;
      expect(text.length, c.id).toBeGreaterThan(30000);
      expect(PRIVATE_MARKER.test(text), c.id).toBe(false);
      expect(GENERATORS[c.generate!](), c.id).toBe(text);
    }
  });

  it.skipIf(process.platform === "win32" || !existsSync(join(plugin, "dist", "hooks-host", "pre-tool-use.js")))("replays cases through the built hooks into the published slices", () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-bench-test-"));
    try {
      const out = join(dir, "result.json");
      const run = spawnSync(process.execPath, [join(bench, "run.mjs"), "--only", "rtk10-ctest-ok,rtk10-ctest-fail", "--out", out], { encoding: "utf8", timeout: 60000 });
      expect(run.status, run.stderr).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8"));
      expect(report.cases).toBe(2);
      expect(report.slices.map((s: { slice: string }) => s.slice)).toEqual(["all", "claude-code-30k-cap", "outputs-under-30k-chars"]);
      const rows = Object.fromEntries(report.rows.map((r: { id: string }) => [r.id, r]));
      expect(rows["rtk10-ctest-fail"].defaultModeTokens).toBe(rows["rtk10-ctest-fail"].rawTokens);
      expect(rows["rtk10-ctest-fail"].commandsRewrittenTokens).toBeLessThan(rows["rtk10-ctest-fail"].rawTokens);
      expect(rows["rtk10-ctest-ok"].defaultModeTokens).toBeLessThan(rows["rtk10-ctest-ok"].rawTokens);
      expect(report.notRewritten).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
