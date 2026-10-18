import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(here, "..", "..", "command-templates");

describe("statically shipped slash commands", () => {
  it("never ships paid-feature commands (reducer is server-delivered + plan-gated like /power)", () => {
    const files = readdirSync(commandsDir);
    expect(files).not.toContain("tkr-reducer.md");
    expect(files).not.toContain("power.md");
    expect(files).not.toContain("reducer.md");
  });
});
