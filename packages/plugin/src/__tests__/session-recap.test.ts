import { describe, expect, it } from "vitest";
import { handleSessionStart } from "../hooks-host/session-recap";
import { rememberOutput } from "../repeat-guard";

const out = `x\n${"y".repeat(3000)}`;

describe("handleSessionStart", () => {
  it("forgets repeated outputs after a compaction so nothing is stubbed against lost context", async () => {
    const s = `sr-${Date.now()}-1`;
    rememberOutput(s, "main", out, "cat a.md");
    await handleSessionStart({ session_id: s, source: "compact" });
    expect(rememberOutput(s, "main", out, "cat a.md")).toBeNull();
  });

  it("keeps the memory on a fresh startup event", async () => {
    const s = `sr-${Date.now()}-2`;
    rememberOutput(s, "main", out, "cat a.md");
    await handleSessionStart({ session_id: s, source: "startup" });
    expect(rememberOutput(s, "main", out, "cat a.md")).toEqual({ cmd: "cat a.md" });
  });
});
