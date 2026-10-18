import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-installer-"));
  for (const name of ["node", "npm", "tkr"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s\\n' '${name}'\" $*\" >> "$INSTALL_LOG"\n${name === "node" ? `exec '${process.execPath.replace(/'/g, "'\\''")}' "$@"` : name === "tkr" ? 'exit "${INSTALL_EXIT:-0}"' : "exit 0"}\n`);
    chmodSync(join(dir, name), 0o755);
  }
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("Unix installer", () => {
  function install(exit = "0") {
    return spawnSync("/bin/bash", [resolve("packages/plugin/scripts/install-mac-linux.sh")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, INSTALL_LOG: join(dir, "calls"), INSTALL_EXIT: exit }
    });
  }

  it("uses the installed CLI to configure and enroll the free installation", () => {
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, "calls"), "utf8")).toContain("tkr shim install");
    expect(result.stdout).not.toContain("paid");
  });

  it("does not report success after configuration fails", () => {
    const result = install("23");
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Done.");
  });
});
