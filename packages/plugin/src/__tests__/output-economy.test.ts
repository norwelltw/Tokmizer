import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processCapturedOutput } from "../exec/wrapper";
import { processOutput, selectFilter, setFilterResolver, type FilterResolver, type LoadedFilter } from "../engine";
import { readFilterDir } from "../engine/loader";
import { Settings } from "../contracts";
import { loadSettingsCache } from "../settings-cache";
import { setYoloMode } from "../yolo-mode";
import { bundledRestore } from "../hooks-host/pre-tool-rewrite";
import { reducerReminder } from "../bonuses";

vi.mock("../state", () => ({ loadState: vi.fn().mockResolvedValue({ token: "fixture", plan: "pro", allowedFilters: null }) }));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn() }));
vi.mock("../learn/recorder", () => ({ recordEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../learn/telemetry", () => ({ recordTelemetry: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../daemon/resolver", () => ({ installDaemonResolver: vi.fn(), closeDaemonResolver: vi.fn() }));

let filters: Map<string, LoadedFilter>;
let resolver: FilterResolver;
let home: string;

function fixture(path: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url)), "utf8");
}

function captured(argv: string[], stdout: string, stderr: string, exitCode: number) {
  return processCapturedOutput(
    { argv, stdout, stderr, exitCode, truncated: false, stderrTruncated: false },
    { yolo: false, env: { ...process.env, TOKMIZER_HOME: home } }
  );
}

beforeAll(async () => {
  filters = await readFilterDir(fileURLToPath(new URL("../../filters", import.meta.url)));
  resolver = async (cmd, allowed) => selectFilter(cmd, filters.values(), allowed, filters);
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tkr-output-economy-"));
  vi.stubEnv("TOKMIZER_HOME", home);
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.mocked(loadSettingsCache).mockResolvedValue(Settings.parse({ outputVerbosity: "normal", telemetryOptIn: false }));
  setFilterResolver(resolver);
  await setYoloMode(false);
});

afterEach(() => {
  setFilterResolver(null);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("delivered output is never longer than what the command printed", () => {
  it("keeps the original when the restore line would cost more characters than the filter saved", async () => {
    const raw = fixture("rtk10/gt-log.txt");
    const r = await captured(["gt", "log"], raw, "", 0);
    expect(r.stdout).toBe(raw);
  });

  it("keeps a failing stderr unchanged when the filter cannot shorten it", async () => {
    const raw = fixture("rtk10/mypy-fail.txt");
    const r = await captured(["mypy", "app.py"], "", raw, 1);
    expect(r.stderr).toBe(raw);
  });
});

describe("a failing command gets the same cleanup on stderr as on stdout", () => {
  it("cleans pulumi's failure printed on stderr and keeps every error line", async () => {
    const raw = fixture("v4/pulumi-up-fail.txt");
    const onStdout = await processOutput("pulumi up --yes", raw, null, { exitCode: 255 });
    const r = await captured(["pulumi", "up", "--yes"], "", raw, 255);
    expect(r.code).toBe(255);
    expect(r.stderr.length).toBeLessThan(raw.length);
    expect(r.stderr).toContain(onStdout.output.trimEnd());
    expect(r.stderr).toMatch(/\[tkr restore [0-9a-f]{16}\]\n$/);
    for (const line of raw.split("\n").filter((l) => /error/i.test(l))) expect(r.stderr).toContain(line);
  });
});

describe("tkr restore works without tkr on PATH", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tkr-restore-path-"));
    writeFileSync(join(dir, "tkr.js"), "");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("points a restore command at the CLI shipped with the plugin", () => {
    const script = join(dir, "tkr.js");
    expect(bundledRestore("tkr restore 0123456789abcdef", undefined, "", script)).toBe(`'${process.execPath}' '${script}' restore 0123456789abcdef`);
    expect(bundledRestore("tkr restore 0123456789abcdef --lines 10:40", undefined, "", script)).toBe(`'${process.execPath}' '${script}' restore 0123456789abcdef --lines 10:40`);
  });

  it("leaves the command alone when tkr is installed, or when it is not a plain restore", () => {
    const script = join(dir, "tkr.js");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tkr"), "#!/bin/sh\n");
    chmodSync(join(bin, "tkr"), 0o755);
    expect(bundledRestore("tkr restore 0123456789abcdef", undefined, bin, script)).toBeNull();
    for (const cmd of ["tkr restore 0123456789abcdef; rm -rf ~", "tkr restore $(id)", "tkr status", "tkr restore zz"]) {
      expect(bundledRestore(cmd, undefined, "", script)).toBeNull();
    }
  });
});

describe("new catalogue entries", () => {
  const route = async (cmd: string, raw: string, exitCode = 0) => processOutput(cmd, raw, null, { exitCode });

  it("drops git transfer progress and keeps the pushed refs", async () => {
    const raw = [
      "Enumerating objects: 9, done.",
      "Counting objects: 100% (9/9), done.",
      "Delta compression using up to 10 threads",
      "Compressing objects: 100% (5/5), done.",
      "Writing objects: 100% (5/5), 1.20 KiB | 1.20 MiB/s, done.",
      "Total 5 (delta 3), reused 0 (delta 0), pack-reused 0",
      "remote: Resolving deltas: 100% (3/3), completed with 3 local objects.",
      "remote: ",
      "remote: Create a pull request for 'feat/x' on GitHub by visiting:",
      "remote:      https://github.com/acme/app/pull/new/feat/x",
      "To github.com:acme/app.git",
      " * [new branch]      feat/x -> feat/x",
      ""
    ].join("\n");
    const r = await route("git push -u origin feat/x", raw);
    expect(r.filterId).toBe("git-sync");
    expect(r.output).toBe([raw.split("\n")[8], raw.split("\n")[9], raw.split("\n")[10], raw.split("\n")[11], ""].join("\n"));
  });

  it("drops package-manager progress and deprecation notices", async () => {
    const raw = [
      "Progress: resolved 412, reused 401, downloaded 11, added 0",
      " WARN  deprecated inflight@1.0.6: This module is not supported",
      "Packages: +412",
      "++++++++++++++++++++++++++++++++++++++++",
      "dependencies:",
      "+ zod 3.23.8",
      "Done in 3.2s",
      ""
    ].join("\n");
    const r = await route("pnpm install", raw);
    expect(r.filterId).toBe("npm");
    expect(r.output).toBe("Packages: +412\ndependencies:\n+ zod 3.23.8\nDone in 3.2s\n");
  });

  it("drops docker layer progress and keeps steps and the image", async () => {
    const raw = [
      "latest: Pulling from library/node",
      "a1b2c3d4e5f6: Pulling fs layer",
      "a1b2c3d4e5f6: Verifying Checksum",
      "a1b2c3d4e5f6: Download complete",
      "a1b2c3d4e5f6: Pull complete",
      "0123456789ab: Already exists",
      "Digest: sha256:abc",
      "Status: Downloaded newer image for node:latest",
      ""
    ].join("\n");
    const r = await route("docker pull node", raw);
    expect(r.filterId).toBe("docker-build");
    expect(r.output).toBe("latest: Pulling from library/node\nDigest: sha256:abc\nStatus: Downloaded newer image for node:latest\n");
  });

  it("keeps failing dart tests and drops passing progress", async () => {
    const raw = [
      "00:01 +0: loading test/cart_test.dart",
      "00:02 +1: Cart adds an item",
      "00:02 +2: Cart removes an item",
      "00:03 +2 -1: Cart applies a coupon [E]",
      "  Expected: <90>",
      "    Actual: <100>",
      "00:03 +2 -1: Some tests failed.",
      ""
    ].join("\n");
    const r = await route("flutter test", raw, 1);
    expect(r.filterId).toBe("dart-test");
    expect(r.output).toContain("Cart applies a coupon [E]");
    expect(r.output).toContain("Actual: <100>");
    expect(r.output).toContain("Some tests failed.");
    const passing = await route("dart test", raw.split("\n").slice(0, 3).join("\n") + "\n00:03 +3: All tests passed!\n");
    expect(passing.output).toBe("00:03 +3: All tests passed!\n");
  });

  it.each([
    ["pylint app", "pylint"],
    ["flake8 src", "flake8"],
    ["stylelint 'src/**/*.css'", "stylelint"],
    ["npx mocha test", "mocha"],
    ["swift test", "swift-test"],
    ["tox -e py312", "tox"],
    ["nox -s tests", "tox"],
    ["fd -e ts src", "fd"],
    ["pdm install", "pdm"],
    ["nix build .#default", "nix"],
    ["nixos-rebuild switch", "nix"],
    ["docker compose up --build", "docker-build"],
    ["docker logs api", "docker"]
  ])("routes %s to %s", async (cmd, slug) => {
    const raw = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
    expect((await route(cmd, raw)).filterId).toBe(slug);
  });
});

describe("per-prompt reducer reminder", () => {
  it("stays a short anchor", () => {
    expect(reducerReminder("balanced")).toBe("TKR REDUCER ACTIVE (balanced), still on.");
  });
});
