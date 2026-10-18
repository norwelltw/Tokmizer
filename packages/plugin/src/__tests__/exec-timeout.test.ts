import { describe, expect, it } from "vitest";
import { resolveExecTimeoutMs } from "../exec/wrapper";

describe("resolveExecTimeoutMs", () => {
  it("defaults to 10 minutes", () => {
    expect(resolveExecTimeoutMs({})).toBe(600000);
  });

  it("honors an explicit TOKMIZER_EXEC_TIMEOUT_MS above all", () => {
    expect(resolveExecTimeoutMs({ TOKMIZER_EXEC_TIMEOUT_MS: "120000", BASH_MAX_TIMEOUT_MS: "900000" })).toBe(120000);
  });

  it("stretches to BASH_MAX_TIMEOUT_MS when the host allows longer runs", () => {
    expect(resolveExecTimeoutMs({ BASH_MAX_TIMEOUT_MS: "1800000" })).toBe(1800000);
  });

  it("never shrinks below the default because of a small BASH_MAX_TIMEOUT_MS", () => {
    expect(resolveExecTimeoutMs({ BASH_MAX_TIMEOUT_MS: "30000" })).toBe(600000);
  });
});
