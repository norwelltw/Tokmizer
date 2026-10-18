import { beforeAll, describe, expect, it } from "vitest";
import { mandatoryFailures, runFidelityBench, type FidelityReport } from "../../scripts/fidelity-bench";

let report: FidelityReport;

beforeAll(async () => {
  report = await runFidelityBench();
}, 120_000);

describe("fidelity bench", () => {
  it("covers at least twelve failure fixtures in both modes and three verbosities", () => {
    expect(report.volets.facts.cases).toBeGreaterThanOrEqual(12 * 2 * 3);
    expect(report.volets.editSafety.cases).toBeGreaterThanOrEqual(3 * 3 * 3);
  });

  it("keeps every fact sheet entry", () => {
    expect(report.volets.facts.failures).toEqual([]);
    expect(report.volets.facts.passed).toBe(report.volets.facts.cases);
  });

  it("restores the original byte for byte", () => {
    expect(report.volets.restore.failures).toEqual([]);
    expect(report.volets.restore.passed).toBe(report.volets.restore.cases);
  });

  it("is deterministic across two isolated runs", () => {
    expect(report.volets.determinism.failed).toBe(0);
    expect(report.volets.determinism.passed).toBe(report.volets.determinism.cases);
  });

  it("adds no foreign line to a file read", () => {
    expect(report.volets.editSafety.failures).toEqual([]);
    expect(report.volets.editSafety.passed).toBe(report.volets.editSafety.cases);
  });

  it("has no loss for --check", () => {
    expect(mandatoryFailures(report)).toEqual([]);
  });
});
