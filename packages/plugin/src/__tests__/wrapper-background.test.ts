import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../license", () => ({ maybeAutoEnroll: vi.fn(async () => null) }));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn(async () => ({ enabled: false })) }));

import { commandLine, runWrapped } from "../exec/wrapper";
import { lastSegment } from "../engine/routing";
import { processOutput } from "../engine";

const unix = process.platform !== "win32";

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-wrap-bg-"));
  origHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = origHome;
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(unix)("runWrapped with background descendants", () => {
  it("returns soon after the child exits even if a descendant keeps the pipes open", async () => {
    const started = Date.now();
    const result = await runWrapped(["sh", "-c", "sleep 15 & echo started; echo oops >&2; exit 3"]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("started\n");
    expect(result.stderr).toBe("oops\n");
  });

  it("still captures output written right before exit", async () => {
    const result = await runWrapped(["sh", "-c", "i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done; printf tail"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(2001);
    expect(lines[0]).toBe("line0");
    expect(lines[1999]).toBe("line1999");
    expect(lines[2000]).toBe("tail");
  });

  it("keeps waiting while a normal command is running", async () => {
    const result = await runWrapped(["sh", "-c", "sleep 0.5; echo done"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("done\n");
  });

  it("collects output a descendant writes shortly after the child exits", async () => {
    const result = await runWrapped(["sh", "-c", "(sleep 0.05; echo late) & echo early"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("early\nlate\n");
  });
});

describe("commandLine", () => {
  it("quotes arguments holding shell metacharacters", () => {
    expect(commandLine(["grep", "-rn", "foo|bar", "src"])).toBe("grep -rn 'foo|bar' src");
    expect(commandLine(["git", "commit", "-m", "it's done"])).toBe("git commit -m 'it'\\''s done'");
    expect(commandLine(["echo", ""])).toBe("echo ''");
    expect(commandLine(["git", "log", "--oneline", "-n", "5", "src/a.ts"])).toBe("git log --oneline -n 5 src/a.ts");
  });

  it("keeps a quoted pipe inside the same command segment", () => {
    expect(lastSegment(commandLine(["grep", "-rn", "foo|bar", "src"]))).toBe(lastSegment("grep -rn foobar src").replace("foobar", "'foo|bar'"));
  });

  it("treats grep exit 1 the same whether or not the pattern holds a pipe", async () => {
    const output = "no match\n".repeat(50);
    const quoted = await processOutput(commandLine(["grep", "-rn", "foo|bar", "src"]), output, null, { exitCode: 1 });
    const plain = await processOutput(commandLine(["grep", "-rn", "foobar", "src"]), output, null, { exitCode: 1 });
    expect(quoted.debugBypass).toBe(plain.debugBypass);
    expect(quoted.debugBypass).toBe(false);
    const joined = await processOutput(["grep", "-rn", "foo|bar", "src"].join(" "), output, null, { exitCode: 1 });
    expect(joined.debugBypass).toBe(true);
  });
});
