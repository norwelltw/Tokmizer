import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formulaWedged, brewTapStatus } from "../brew";

const CLEAN = `class Tokmizer < Formula
  desc "Cuts the tokens your AI coding agent burns on command output"
  url "https://registry.npmjs.org/@tokmizer/plugin/-/plugin-0.9.28.tgz"
  sha256 "0ed3599036a51b6c359174d705f5e19d080e21f356cbbcfd0c00894da94a79ba"
  license :cannot_represent
end
`;

const WEDGED = `class Tokmizer < Formula
<<<<<<< HEAD
  url "https://registry.npmjs.org/@tokmizer/plugin/-/plugin-0.4.8.tgz"
=======
  url "https://registry.npmjs.org/@tokmizer/plugin/-/plugin-0.9.28.tgz"
>>>>>>> 1e01c29 (tap: tokmizer 0.4.6)
end
`;

describe("homebrew tap wedge detection", () => {
  it("flags a formula with git conflict markers", () => {
    expect(formulaWedged(WEDGED)).toBe(true);
  });

  it("accepts a clean formula", () => {
    expect(formulaWedged(CLEAN)).toBe(false);
  });

  it("brewTapStatus reads the first existing formula path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-brew-"));
    try {
      const formula = join(dir, "tokmizer.rb");
      writeFileSync(formula, WEDGED);
      const status = brewTapStatus([join(dir, "missing.rb"), formula]);
      expect(status).toEqual({ path: formula, wedged: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("brewTapStatus returns null without a tap", () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-brew-"));
    mkdirSync(dir, { recursive: true });
    try {
      expect(brewTapStatus([join(dir, "missing.rb")])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
