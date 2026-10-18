import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processCapturedOutput } from "../exec/wrapper";
import { selectFilter, setFilterResolver, type FilterResolver, type LoadedFilter } from "../engine";
import { readFilterDir } from "../engine/loader";
import { Settings } from "../contracts";
import { loadSettingsCache } from "../settings-cache";
import { readContentCache } from "../content-cache";
import { setYoloMode } from "../yolo-mode";

vi.mock("../state", () => ({ loadState: vi.fn().mockResolvedValue({ token: "fixture", plan: "pro", allowedFilters: null }) }));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn() }));
vi.mock("../learn/recorder", () => ({ recordEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../learn/telemetry", () => ({ recordTelemetry: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../daemon/resolver", () => ({ installDaemonResolver: vi.fn(), closeDaemonResolver: vi.fn() }));

let filters: Map<string, LoadedFilter>;
let resolver: FilterResolver;
let home: string;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/test-failures/${name}`, import.meta.url)), "utf8");
}

function restored(text: string): Promise<string | null> {
  const hash = /\[tkr restore ([0-9a-f]+)\]$/.exec(text.trimEnd())?.[1];
  expect(hash).toBeDefined();
  return readContentCache(hash!);
}

beforeAll(async () => {
  filters = await readFilterDir(fileURLToPath(new URL("../../filters", import.meta.url)));
  resolver = async (cmd, allowed) => selectFilter(cmd, filters.values(), allowed, filters);
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tkr-test-failures-"));
  vi.stubEnv("TOKMIZER_HOME", home);
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.mocked(loadSettingsCache).mockResolvedValue(Settings.parse({ outputVerbosity: "compact", telemetryOptIn: false }));
  setFilterResolver(resolver);
  await setYoloMode(false);
});

afterEach(() => {
  setFilterResolver(null);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("failing test runs through the command wrapper", () => {
  it("summarises vitest details written to stderr and restores the full original", async () => {
    const stdout = fixture("vitest-stdout.txt");
    const stderr = fixture("vitest-stderr.txt");
    const result = await processCapturedOutput(
      { argv: ["npx", "vitest", "run"], stdout, stderr, exitCode: 1, truncated: false, stderrTruncated: false },
      { yolo: false, env: process.env, resolver }
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("user > builds admin :7:50");
    expect(result.stderr).toContain("TypeError: cannot read properties of undefined (reading 'x')");
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(Buffer.byteLength(stderr) / 3);
    expect(await restored(result.stderr)).toBe(stderr);
    expect(result.stdout).toContain("Tests 9 failed | 26 passed (35)");
    expect(await restored(result.stdout)).toBe(stdout);
  });

  it("summarises jest, which reports only on stderr", async () => {
    const stderr = fixture("jest.txt");
    const result = await processCapturedOutput(
      { argv: ["npx", "jest", "--ci"], stdout: "", stderr, exitCode: 1, truncated: false, stderrTruncated: false },
      { yolo: false, env: process.env, resolver }
    );
    expect(result.stderr).toContain("cart › lookup missing src/cart.js:2:41");
    expect(result.stderr).toContain("Expected: 11");
    expect(await restored(result.stderr)).toBe(stderr);
  });

  it("keeps stderr of other failing commands untouched", async () => {
    const stderr = fixture("jest.txt");
    const result = await processCapturedOutput(
      { argv: ["node", "build.js"], stdout: "", stderr, exitCode: 1, truncated: false, stderrTruncated: false },
      { yolo: false, env: process.env, resolver }
    );
    expect(result.stderr).toBe(stderr);
  });
});
