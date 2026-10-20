import { beforeEach, describe, expect, it, vi } from "vitest";

const kick = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ value: null as null | { token: string; plan: string } }));
vi.mock("../exec/wrapper", async (importOriginal) => ({ ...(await importOriginal<typeof import("../exec/wrapper")>()), kickBackgroundEnroll: kick }));
vi.mock("../state", () => ({ loadState: vi.fn(async () => state.value) }));

import { processToolOutput } from "../hooks-host/post-tool-process";

const payload = {
  session_id: "s",
  tool_name: "Bash",
  tool_input: { command: "git status" },
  tool_response: { stdout: "On branch main\n", stderr: "", interrupted: false }
};

beforeEach(() => {
  kick.mockClear();
});

describe("sign-up from PostToolUse", () => {
  it("starts the sign-up of an install that has none yet", async () => {
    state.value = null;
    await processToolOutput(payload);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("leaves a signed-up install alone", async () => {
    state.value = { token: "tok_x", plan: "free" };
    await processToolOutput(payload);
    expect(kick).not.toHaveBeenCalled();
  });
});
