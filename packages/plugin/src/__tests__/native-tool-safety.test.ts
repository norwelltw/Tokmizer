import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHookEnvelope, processToolOutput } from "../hooks-host/post-tool-use";
import { readContentCache } from "../content-cache";
import { loadFilters, setFilterResolver, selectFilter, READ_FOLD_MIN_BYTES } from "../engine";

vi.mock("../state", () => ({ loadState: vi.fn().mockResolvedValue({ token: "tok_x", plan: "smart" }) }));
vi.mock("../learn/recorder", () => ({ recordEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../learn/telemetry", () => ({ recordTelemetry: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../stats", async (orig) => ({ ...(await orig<typeof import("../stats")>()), recordStat: vi.fn() }));
const settingsHolder = vi.hoisted(() => ({
  value: { enabled: true, telemetryOptIn: false, outputVerbosity: "compact", filters: { enableAll: true, disabled: [] } }
}));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn(async () => settingsHolder.value) }));
vi.mock("../daemon/resolver", () => ({ installDaemonResolver: vi.fn(), closeDaemonResolver: vi.fn() }));

beforeEach(async () => {
  const filters = await loadFilters();
  setFilterResolver(async (cmd, allowed) => selectFilter(cmd, filters.values(), allowed, filters));
});

afterEach(() => {
  setFilterResolver(null);
  settingsHolder.value = { ...settingsHolder.value, outputVerbosity: "compact" };
});

function splitHint(delivered: string): { body: string; hash: string | null } {
  const hint = /\n\[tkr restore ([0-9a-f]+)\]\n?$/.exec(delivered);
  return hint ? { body: delivered.slice(0, hint.index), hash: hint[1]! } : { body: delivered, hash: null };
}

const TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/home/user/app/app.py", line 12, in <module>',
  "    main()",
  '  File "/home/user/app/app.py", line 7, in load',
  "    return cfg['database']['url']",
  "KeyError: 'url'"
];

function pythonRun(batches: number): string {
  const log = Array.from({ length: batches }, (_, i) => `2026-10-16 10:00:00 INFO worker: processed batch ${i} rows=${1000 + i}`);
  return [...log, ...TRACEBACK, ""].join("\n");
}

describe("Python traceback buried in application logs", () => {
  it("drops the repetitive log while keeping the whole traceback, the error line and a full restore", async () => {
    const raw = pythonRun(400);
    const delivered = await processToolOutput({ tool_name: "Bash", tool_input: { command: "python3 app.py" }, tool_response: { stdout: raw, stderr: "" } });
    expect(delivered).not.toBeNull();
    const { body, hash } = splitHint(delivered!);
    for (const line of TRACEBACK) expect(body).toContain(line);
    expect(body).toContain("similar log lines dropped");
    expect(body).toContain("processed batch 399 rows=1399");
    expect(Buffer.byteLength(body)).toBeLessThan(Buffer.byteLength(raw) / 10);
    expect(await readContentCache(hash!)).toBe(raw);
  });

  it("leaves a short failing run untouched", async () => {
    const raw = pythonRun(20);
    expect(await processToolOutput({ tool_name: "Bash", tool_input: { command: "python3 app.py" }, tool_response: { stdout: raw, stderr: "" } })).toBeNull();
  });
});

function codeFile(functions: number): string {
  return Array.from({ length: functions }, (_, index) => [
    `export function widget${index}(input: string): string {`,
    ...Array.from({ length: 20 }, (_, i) => `  const part${i} = input.slice(${i}).padStart(${i + 4}, "0");`),
    "  return part0 + part1;",
    "}",
    ""
  ].join("\n")).join("\n");
}

describe("Read output stays safe to edit from", () => {
  it.each(["normal", "compact", "minimal"])("never folds a file under the size threshold (%s)", async (verbosity) => {
    settingsHolder.value = { ...settingsHolder.value, outputVerbosity: verbosity };
    let source = codeFile(10);
    while (Buffer.byteLength(source) < READ_FOLD_MIN_BYTES - 2048) source += codeFile(5);
    expect(Buffer.byteLength(source)).toBeLessThan(READ_FOLD_MIN_BYTES);
    expect(await processToolOutput({ tool_name: "Read", tool_input: { file_path: "/x/medium.ts" }, tool_response: { file: { content: source } } })).toBeNull();
  });

  it("never folds a ranged Read, even of a large file", async () => {
    const source = codeFile(120);
    expect(Buffer.byteLength(source)).toBeGreaterThan(READ_FOLD_MIN_BYTES);
    expect(await processToolOutput({ tool_name: "Read", tool_input: { file_path: "/x/big.ts", offset: 1, limit: 2000 }, tool_response: { file: { content: source } } })).toBeNull();
    expect(await processToolOutput({ tool_name: "Read", tool_input: { file_path: "/x/big.ts", limit: 50 }, tool_response: { file: { content: source } } })).toBeNull();
  });

  it("marks every fold of a large file with its exact line range and the Read call that shows it", async () => {
    const source = codeFile(120);
    const delivered = await processToolOutput({ tool_name: "Read", tool_input: { file_path: "/x/big.ts" }, tool_response: { file: { content: source } } });
    expect(delivered).not.toBeNull();
    const { body, hash } = splitHint(delivered!);
    expect(await readContentCache(hash!)).toBe(source);
    const sourceLines = source.split("\n");
    const lines = body.split("\n");
    expect(lines.at(-1)).toBe("[tkr: partial view; folded or omitted lines are not file text. Read with offset/limit for the exact lines before Edit or Write]");
    const markers = lines
      .map((line, index) => ({ index, m: /… (\d+) lines folded \((\d+)-(\d+)\): Read offset=(\d+) limit=(\d+) before editing …$/.exec(line) }))
      .filter((x) => x.m);
    expect(markers.length).toBeGreaterThan(10);
    const hidden = new Set<number>();
    for (const { index, m } of markers) {
      const [count, first, last, offset, limit] = m!.slice(1).map(Number) as [number, number, number, number, number];
      expect(index + 1).toBe(first);
      expect(offset).toBe(first);
      expect(limit).toBe(count);
      expect(last - first + 1).toBe(count);
      expect(sourceLines[last]).toBe("}");
      for (let line = first; line <= last; line++) hidden.add(line - 1);
    }
    const omitted = lines.findIndex((line) => /^… \(\d+ more lines omitted\)$/.test(line));
    const visibleEnd = omitted < 0 ? lines.length - 1 : omitted;
    for (let i = 0; i < visibleEnd; i++) {
      if (!hidden.has(i)) expect(lines[i]).toBe(sourceLines[i]);
    }
  });
});

function globPaths(count: number): string[] {
  const dirs = ["src", "src/engine", "src/engine/transforms", "src/__tests__", "scripts"];
  return Array.from({ length: count }, (_, i) => `/repo/pkg/${dirs[i % dirs.length]}/file${i}.ts`);
}

function expandGrouped(lines: string[]): string[] {
  const head = /^(\d+)F \d+D(?: in (.+\/))?:$/.exec(lines[0]!);
  expect(head).not.toBeNull();
  const root = head![2] ?? "";
  return lines.slice(1).flatMap((line) => {
    const m = /^(.*?\/) \(\d+(?:, \*(\.[\w.]+))?\): (.+)$/.exec(line)!;
    const dir = m[1] === "./" ? root : `${root}${m[1]}`;
    return m[3]!.split(" ").map((name) => `${dir}${name}${m[2] ?? ""}`);
  });
}

describe("Glob output", () => {
  it("groups many paths by directory, keeps every path recoverable and restorable", async () => {
    const filenames = globPaths(229);
    const payload = { tool_name: "Glob", tool_input: { pattern: "**/*.ts" }, tool_response: { filenames, durationMs: 4, numFiles: 229, truncated: false } };
    const delivered = await processToolOutput(payload);
    expect(delivered).not.toBeNull();
    const { body, hash } = splitHint(delivered!);
    expect(Buffer.byteLength(body)).toBeLessThan(Buffer.byteLength(filenames.join("\n")) / 2);
    expect(new Set(expandGrouped(body.split("\n")))).toEqual(new Set(filenames));
    expect(await readContentCache(hash!)).toBe(filenames.join("\n"));
    const envelope = JSON.parse(buildHookEnvelope(payload, delivered!));
    expect(envelope.hookSpecificOutput.updatedToolOutput).toMatchObject({ numFiles: 229, truncated: false });
    expect(envelope.hookSpecificOutput.updatedToolOutput.filenames).toEqual(delivered!.replace(/\n$/, "").split("\n"));
  });

  it("leaves a short Glob result untouched", async () => {
    const filenames = globPaths(9);
    expect(await processToolOutput({ tool_name: "Glob", tool_input: { pattern: "**/*.ts" }, tool_response: { filenames, numFiles: 9 } })).toBeNull();
  });

  it("groups a Glob result from ten paths without losing any of them", async () => {
    const filenames = globPaths(10);
    const delivered = await processToolOutput({ tool_name: "Glob", tool_input: { pattern: "**/*.ts" }, tool_response: { filenames, numFiles: 10 } });
    expect(delivered).not.toBeNull();
    const { body } = splitHint(delivered!);
    expect(Buffer.byteLength(delivered!)).toBeLessThan(Buffer.byteLength(filenames.join("\n")));
    expect(new Set(expandGrouped(body.split("\n")))).toEqual(new Set(filenames));
  });
});
