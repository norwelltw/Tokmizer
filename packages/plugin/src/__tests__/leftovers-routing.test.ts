import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFilters, processOutput, selectFilter, setFilterResolver } from "../engine";
import { __resetCache } from "../engine/loader";
import { __resetMatcherCache } from "../engine/matcher";
import { normalizeHead, routingCandidates } from "../engine/routing";

beforeEach(() => {
  process.env.TOKMIZER_DEV = "1";
  __resetCache();
  __resetMatcherCache();
  setFilterResolver(async (cmd, allowed) => selectFilter(cmd, (await loadFilters()).values(), allowed));
});

afterEach(() => {
  setFilterResolver(null);
  __resetCache();
  __resetMatcherCache();
});

async function slugFor(cmd: string): Promise<string | null> {
  const filters = await loadFilters();
  for (const candidate of routingCandidates(cmd)) {
    const hit = selectFilter(candidate, filters.values(), null);
    if (hit) return hit.slug;
  }
  return null;
}

describe("normalizeHead: Windows-style heads", () => {
  it.each([
    ["python.exe -m pytest", "python -m pytest"],
    ["PYTEST.EXE -q", "PYTEST -q"],
    ["py -m pytest", "python -m pytest"],
    ["py -3 -m pytest", "python -m pytest"],
    ["py -3.12 -m pytest -q", "python -m pytest -q"],
    ["C:\\Python312\\python.exe -m pytest", "python -m pytest"],
    [".\\venv\\Scripts\\pytest.exe", "pytest"],
    ["dotnet.exe test", "dotnet test"],
    ["npm.cmd test", "npm test"],
    ["npx.cmd vitest run", "npx vitest run"],
    ["node.exe script.js", "node script.js"],
    ["tool.BAT x", "tool x"],
    ["pwsh.ps1 x", "pwsh x"]
  ])("%s -> %s", (input, expected) => {
    expect(normalizeHead(input)).toBe(expected);
  });
});

describe("Windows-style heads route to the same filter as POSIX heads", () => {
  it.each([
    ["python -m pytest", "pytest"],
    ["python3 -m pytest -q", "pytest"],
    ["python.exe -m pytest", "pytest"],
    ["pytest.exe", "pytest"],
    ["py -m pytest", "pytest"],
    ["py -3 -m pytest", "pytest"],
    ["C:\\Python312\\python.exe -m pytest", "pytest"],
    [".\\venv\\Scripts\\pytest.exe", "pytest"],
    ["dotnet.exe test", "dotnet"],
    ["npm.cmd test", "npm-test"],
    ["npx.cmd vitest run", "vitest"]
  ])("%s", async (cmd, slug) => {
    const got = await slugFor(cmd);
    expect(got).not.toBeNull();
    expect(got).toBe(slug === "pytest" ? "pytest" : await slugFor(cmd.replace(/\.(exe|cmd)\b/g, "")));
  });

  it("pytest variants all resolve to the pytest filter", async () => {
    for (const c of ["python -m pytest", "python3 -m pytest", "python.exe -m pytest", "pytest.exe", "py -m pytest", "py -3 -m pytest", "C:\\Python312\\python.exe -m pytest", ".\\venv\\Scripts\\pytest.exe"]) {
      expect(await slugFor(c), c).toBe("pytest");
    }
  });

  it("node.exe routes like node", async () => {
    expect(await slugFor("node.exe script.js")).toBe(await slugFor("node script.js"));
  });
});

describe("deno success with empty output", () => {
  it.each([
    ["deno check main.ts", "deno: ok"],
    ["deno lint", "deno: ok"],
    ["deno fmt --check", "deno: ok"]
  ])("%s -> %s on exit 0", async (cmd, text) => {
    const r = await processOutput(cmd, "", null, { verbosity: "compact", exitCode: 0 });
    expect(r.output.trim()).toBe(text);
  });

  it("does not print ok on failure and keeps failure lines verbatim", async () => {
    const raw = "error: TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.\n    at file:///x/main.ts:1:7\n";
    const r = await processOutput("deno check main.ts", raw, null, { verbosity: "compact", exitCode: 1 });
    expect(r.output).toContain("error: TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.");
    expect(r.output).not.toContain("deno: ok");
  });
});
