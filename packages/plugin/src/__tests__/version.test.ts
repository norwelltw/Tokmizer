import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { PLUGIN_VERSION } from "../version";

const req = createRequire(import.meta.url);

describe("PLUGIN_VERSION", () => {
  it("matches package.json version", () => {
    expect(PLUGIN_VERSION).toBe(req("../../package.json").version);
  });
});
