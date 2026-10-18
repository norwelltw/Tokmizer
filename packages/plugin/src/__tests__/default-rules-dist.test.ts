import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXEC_BIN = join(PKG_ROOT, "dist", "bin", "tkr-exec.js");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-fresh-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!existsSync(EXEC_BIN))("shipped default rules", () => {
  it("keeps filter contents out of the readable dist", () => {
    const dist = readFileSync(EXEC_BIN, "utf8");
    expect(dist).not.toContain("TOKMIZER_DEFAULT_RULES");
    expect(dist).not.toContain("git log: no commits");
    expect(dist).not.toContain("git status: clean");
    expect(dist).not.toContain("Cap large cat output");
  });

  it("passes the dist and pack guards", () => {
    for (const guard of ["check-dist-clean.mjs", "check-pack-clean.mjs"]) {
      execFileSync(process.execPath, [join(PKG_ROOT, "scripts", guard)], { cwd: PKG_ROOT, stdio: "pipe" });
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("compresses on a fresh home with the server unreachable", () => {
    const big = join(home, "big.ts");
    writeFileSync(big, Array.from({ length: 1500 }, (_, i) => `const line${i} = ${i};`).join("\n") + "\n");
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TOKMIZER_HOME: join(home, "tokmizer"),
      TOKMIZER_BASE_URL: "http://127.0.0.1:9",
      TOKMIZER_AUTO_UPDATE: "0",
      TOKMIZER_TKR_BIN: join(home, "missing-tkr.js")
    };
    const raw = readFileSync(big);
    const out = execFileSync(process.execPath, [EXEC_BIN, "cat", big], { env, cwd: dirname(big), maxBuffer: 16 * 1024 * 1024 });
    expect(existsSync(join(env.TOKMIZER_HOME, "state.json"))).toBe(false);
    expect(out.length).toBeLessThan(raw.length / 2);
  }, 30_000);
});
