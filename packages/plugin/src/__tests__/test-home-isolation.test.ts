import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { tokmizerHome } from "../paths";

const realHome = process.env.TOKMIZER_TEST_REAL_HOME;
const forbidden = process.env.TOKMIZER_TEST_FORBIDDEN_HOME;
const repo = resolve(__dirname, "../../../..");
let scratch: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "tkr-home-guard-")));
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

describe("tests never use the real Tokmizer home", () => {
  it("runs every worker with a sandboxed HOME, TOKMIZER_HOME and PATH", () => {
    expect(realHome).toBeTruthy();
    expect(forbidden).toBe(join(realHome!, ".tokmizer"));
    expect(homedir()).not.toBe(realHome);
    expect(process.env.HOME).not.toBe(realHome);
    expect(inside(tokmizerHome(), forbidden!)).toBe(false);
    expect((process.env.PATH ?? "").split(delimiter).some((entry) => /[\\/]\.tokmizer[\\/]shims[\\/]?$/.test(entry))).toBe(false);
  });

  it("gives child processes the same sandbox", () => {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify([require('os').homedir(), process.env.TOKMIZER_HOME]))"], { encoding: "utf8" });
    const [home, tkrHome] = JSON.parse(child.stdout) as [string, string];
    expect(home).not.toBe(realHome);
    expect(inside(tkrHome, forbidden!)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("blocks and reports a child that writes into the forbidden home", () => {
    const fake = join(scratch, ".tokmizer");
    const log = join(scratch, "violations.log");
    writeFileSync(log, "");
    const child = spawnSync(process.execPath, ["-e", `
      const fs = require("fs");
      try { fs.mkdirSync(${JSON.stringify(fake)}, { recursive: true }); } catch {}
      try { fs.appendFileSync(${JSON.stringify(join(fake, "daemon.log"))}, "x"); } catch {}
      process.stdout.write(String(fs.existsSync(${JSON.stringify(fake)})));
    `], { encoding: "utf8", env: { ...process.env, TOKMIZER_TEST_FORBIDDEN_HOME: fake, TOKMIZER_TEST_VIOLATIONS: log } });
    expect(child.stdout).toBe("false");
    expect(existsSync(fake)).toBe(false);
    const found = readFileSync(log, "utf8");
    expect(found).toContain(`mkdirSync ${fake}`);
    expect(found).toContain(`appendFileSync ${join(fake, "daemon.log")}`);
  });

  it("never spawns a test process with a hand-built environment that drops the sandboxed home", () => {
    const offenders: string[] = [];
    const tests = readdirSync(__dirname).filter((name) => name.endsWith(".ts"));
    const call = /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s*\(/g;
    for (const name of tests) {
      const source = readFileSync(join(__dirname, name), "utf8");
      for (const match of source.matchAll(call)) {
        let depth = 1;
        let end = match.index! + match[0].length;
        while (end < source.length && depth > 0) {
          const char = source[end]!;
          if ("([{".includes(char)) depth += 1;
          else if (")]}".includes(char)) depth -= 1;
          end += 1;
        }
        const args = source.slice(match.index! + match[0].length, end - 1);
        const env = /\benv\s*:\s*\{/.exec(args);
        if (!env) continue;
        let close = env.index + env[0].length;
        let braces = 1;
        while (close < args.length && braces > 0) {
          if (args[close] === "{") braces += 1;
          else if (args[close] === "}") braces -= 1;
          close += 1;
        }
        const object = args.slice(env.index, close);
        if (!/\bTOKMIZER_HOME\b|\.\.\./.test(object)) offenders.push(`${name}:${source.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("smokes the published bundle with an isolated home", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "packages", "plugin", "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.prepublishOnly).toContain("node scripts/smoke-dist.mjs");
    expect(pkg.scripts.prepublishOnly).not.toMatch(/node dist\/bin\/tkr(?:-exec)?\.js/);
    const smoke = readFileSync(join(repo, "packages", "plugin", "scripts", "smoke-dist.mjs"), "utf8");
    expect(smoke).toMatch(/TOKMIZER_HOME: home/);
    expect(smoke).toMatch(/HOME: root/);
  });
});
