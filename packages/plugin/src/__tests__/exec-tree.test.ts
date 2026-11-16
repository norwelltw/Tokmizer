import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { descendants } from "../exec/wrapper";

describe.skipIf(process.platform === "win32")("descendants", () => {
  it("finds the grandchildren a timed-out command would leave behind", async () => {
    const child = spawn("bash", ["-c", "sleep 30 & sleep 30; true"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(descendants(child.pid).length).toBeGreaterThanOrEqual(2);
    } finally {
      for (const pid of descendants(child.pid)) process.kill(pid, "SIGKILL");
      child.kill("SIGKILL");
    }
  });

  it("returns nothing for a process without children or no pid", () => {
    expect(descendants(undefined)).toEqual([]);
    expect(descendants(2 ** 22 + 12345)).toEqual([]);
  });
});
