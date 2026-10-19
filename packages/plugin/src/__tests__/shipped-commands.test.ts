import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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

  it("keeps every command out of the model context", () => {
    const files = readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const frontmatter = readFileSync(join(commandsDir, f), "utf8").split(/^---$/m)[1] ?? "";
      expect(frontmatter, f).toMatch(/^disable-model-invocation: true$/m);
    }
  });
});
