import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processCapturedOutput, runWrapped } from "../exec/wrapper";
import { selectFilter, setFilterResolver, type FilterResolver, type LoadedFilter } from "../engine";
import { readFilterDir } from "../engine/loader";
import { READ_EDIT_NOTICE } from "../engine/read-notice";
import { Settings } from "../contracts";
import { loadSettingsCache } from "../settings-cache";
import { setYoloMode } from "../yolo-mode";

vi.mock("../state", () => ({ loadState: vi.fn().mockResolvedValue({ token: "fixture", plan: "pro" }) }));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn() }));
vi.mock("../learn/recorder", () => ({ recordEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../learn/telemetry", () => ({ recordTelemetry: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../daemon/resolver", () => ({ installDaemonResolver: vi.fn(), closeDaemonResolver: vi.fn() }));

const longSource = Array.from({ length: 120 }, (_, i) => [
  `export function handler${i}(input: { id: number; name: string }): string {`,
  `  const label = \`\${input.name}-\${input.id}-${i}\`;`,
  `  if (input.id > ${i}) {`,
  `    return label.toUpperCase();`,
  `  }`,
  `  return label.padEnd(${20 + i}, "-");`,
  `}`,
  ``
].join("\n")).join("\n");
const shortSource = "export const answer = 42;\nexport function double(x: number): number {\n  return x * 2;\n}\n";

let home: string;
let filters: Map<string, LoadedFilter>;
let resolver: FilterResolver;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tkr-read-notice-"));
  vi.stubEnv("TOKMIZER_HOME", home);
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.mocked(loadSettingsCache).mockResolvedValue(Settings.parse({ outputVerbosity: "normal", telemetryOptIn: false }));
  filters ??= await readFilterDir(fileURLToPath(new URL("../../filters", import.meta.url)));
  resolver = async (cmd, allowed) => selectFilter(cmd, filters.values(), allowed, filters);
  setFilterResolver(resolver);
  await setYoloMode(false);
});

afterEach(() => {
  setFilterResolver(null);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function captured(argv: string[], stdout: string) {
  return { argv, stdout, stderr: "", exitCode: 0, truncated: false, stderrTruncated: false };
}

describe("file reads compressed on the exec path", () => {
  it.each([
    [["cat", "src/big.ts"]],
    [["head", "-n", "600", "src/big.ts"]],
    [["nl", "src/big.ts"]],
    [["/bin/cat", "src/big.ts"]]
  ])("flag %j as a partial view", async (argv) => {
    const result = await processCapturedOutput(captured(argv, longSource), { yolo: false, env: { CODEX_CLI: "1" }, resolver });
    expect(result.filteredBytes).toBeLessThan(result.rawBytes);
    expect(result.stdout).toContain(READ_EDIT_NOTICE);
  });

  it("leaves an unchanged read without the notice", async () => {
    const result = await processCapturedOutput(captured(["cat", "src/small.ts"], shortSource), { yolo: false, env: { CODEX_CLI: "1" }, resolver });
    expect(result.stdout).toBe(shortSource);
    expect(result.stdout).not.toContain(READ_EDIT_NOTICE);
  });

  it("does not flag other compressed commands", async () => {
    const listing = Array.from({ length: 400 }, (_, i) => `line ${i} of a generated report`).join("\n");
    const result = await processCapturedOutput(captured(["seq-report"], listing), {
      yolo: false,
      env: { CODEX_CLI: "1" },
      resolver: async () => ({ ...filters.get("head")!, matchRegex: /.*/ })
    });
    expect(result.filteredBytes).toBeLessThan(result.rawBytes);
    expect(result.stdout).not.toContain(READ_EDIT_NOTICE);
  });

  it("adds the notice when tkr-exec really runs cat on a long file and not on a short one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-read-notice-src-"));
    try {
      writeFileSync(join(dir, "big.ts"), longSource);
      writeFileSync(join(dir, "small.ts"), shortSource);
      const big = await runWrapped(["cat", join(dir, "big.ts")]);
      expect(big.filteredBytes).toBeLessThan(big.rawBytes);
      expect(big.stdout).toContain(READ_EDIT_NOTICE);
      const small = await runWrapped(["cat", join(dir, "small.ts")]);
      expect(small.stdout).toBe(shortSource);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
