import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadFilters, processOutput, selectFilter, setFilterResolver } from "../engine";
import { __resetCache } from "../engine/loader";
import { __resetMatcherCache } from "../engine/matcher";
import { stripAnsi } from "../engine/transforms/strip-ansi";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/v4/${name}.txt`, import.meta.url)), "utf8");
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

let origDev: string | undefined;

beforeEach(() => {
  origDev = process.env.TOKMIZER_DEV;
  process.env.TOKMIZER_DEV = "1";
  __resetCache();
  __resetMatcherCache();
  setFilterResolver(async (cmd, allowed) => selectFilter(cmd, (await loadFilters()).values(), allowed));
});

afterEach(() => {
  setFilterResolver(null);
  if (origDev === undefined) delete process.env.TOKMIZER_DEV;
  else process.env.TOKMIZER_DEV = origDev;
  __resetCache();
  __resetMatcherCache();
});

const FAILURE_MARK = /FAIL|ERROR|Error|error|✗|\(fail\)|Exception|Expected|Received|\*\*\*/;
const PASSING_SUMMARY = /Failures: 0, Errors: 0/;
const MVN_NOISE = /^(?:\[[^\]\s]+\] )?\[INFO\]/;

type Case = { name: string; cmd: string; exit: number; slug: string; minSaved: number; noise: RegExp | null };

const CASES: Case[] = [
  { name: "bun-test-real", cmd: "bun test", exit: 1, slug: "bun-test", minSaved: 0.8, noise: /^\(pass\) |^\S+\.test\.ts:$|^\s*$/ },
  { name: "bun-test-fail", cmd: "bun test", exit: 1, slug: "bun-test", minSaved: 0, noise: /^\(pass\) |^\s*$/ },
  { name: "bun-test-green", cmd: "bun test", exit: 0, slug: "bun-test", minSaved: 0, noise: /^\s*$/ },
  { name: "bun-install", cmd: "bun install", exit: 0, slug: "bun", minSaved: 0.6, noise: /^\s*$|^Resolving dependencies|^Resolved, downloaded and extracted|^Saved lockfile/ },
  { name: "deno-test-fail", cmd: "deno test", exit: 1, slug: "deno", minSaved: 0.5, noise: /^\s*$|^Check |^running \d+ tests? from |\.\.\. ok \(/ },
  { name: "deno-test-green", cmd: "deno test", exit: 0, slug: "deno", minSaved: 0.45, noise: /^\s*$|^Check |^running \d+ tests? from |\.\.\. ok \(/ },
  { name: "deno-lint", cmd: "deno lint", exit: 1, slug: "deno", minSaved: 0.4, noise: /^\s*$/ },
  { name: "pulumi-preview", cmd: "pulumi preview", exit: 0, slug: "pulumi", minSaved: 0.02, noise: /^\s*$|^View in Browser|^\s*Type\s+Name\s+Plan/ },
  { name: "pulumi-up-fail", cmd: "pulumi up --yes", exit: 255, slug: "pulumi", minSaved: 0.02, noise: /^\s*$|^View in Browser|^\s*Type\s+Name\s+Status/ },
  { name: "composer-install-fail", cmd: "composer install", exit: 1, slug: "composer", minSaved: 0.9, noise: /^\s*-\s+(?:Installing|Downloading) |^\s*$/ },
  { name: "phpunit-fail", cmd: "phpunit", exit: 1, slug: "phpunit", minSaved: 0.4, noise: /^(?:Runtime|Configuration):\s|^[.SIRDWFEN]+\s+\d+ \/ \d+ \(\s*\d+%\)$|^\s*$/ },
  { name: "phpstan", cmd: "phpstan analyse src", exit: 1, slug: "phpstan", minSaved: 0.38, noise: /^\s*\d+\/\d+ \[|^\s*-{3,}\s+-{3,}\s*$|^\s*$/ },
  { name: "ctest-mixed", cmd: "ctest", exit: 8, slug: "ctest", minSaved: 0.2, noise: /^\s+Start\s+\d+: |\s+Passed\s+[\d.]+ sec$|^\s*$/ },
  { name: "ctest-noisy-fail", cmd: "ctest --output-on-failure", exit: 8, slug: "ctest", minSaved: 0.05, noise: /^\s+Start\s+\d+: |\s+Passed\s+[\d.]+ sec$|^\s*$/ },
  { name: "ctest-200", cmd: "ctest", exit: 8, slug: "ctest", minSaved: 0.95, noise: /^\s+Start\s+\d+: |\s+Passed\s+[\d.]+ sec$|^\s*$/ },
  { name: "mvnd-test-fail", cmd: "mvnd test", exit: 1, slug: "mvn", minSaved: 0.3, noise: MVN_NOISE },
  { name: "mvnd-reactor-fail", cmd: "mvnd test", exit: 1, slug: "mvn", minSaved: 0.55, noise: MVN_NOISE },
  { name: "mvnd-reactor-pass", cmd: "mvnd install", exit: 0, slug: "mvn", minSaved: 0.8, noise: MVN_NOISE },
  { name: "mvnd-compile-error", cmd: "mvnd compile", exit: 1, slug: "mvn", minSaved: 0.5, noise: MVN_NOISE },
  { name: "sbt-test-fail", cmd: "sbt test", exit: 1, slug: "sbt", minSaved: 0.45, noise: /^\[info\] (?!.*\*\*\* FAILED)|^\s*$/ },
  { name: "sbt-test-pass", cmd: "sbt test", exit: 0, slug: "sbt", minSaved: 0.7, noise: /^\[info\] |^\s*$/ },
  { name: "sbt-compile-error", cmd: "sbt compile", exit: 1, slug: "sbt", minSaved: 0.3, noise: /^\[info\] /},
  { name: "sqlfluff-lint", cmd: "sqlfluff lint models/", exit: 1, slug: "sqlfluff", minSaved: 0, noise: null }
];

describe("benchmark v4 fixtures", () => {
  it.each(CASES)("$name: routed to $slug, compressed, only passing noise dropped", async ({ name, cmd, exit, slug, minSaved, noise }) => {
    const raw = fixture(name);
    const r = await processOutput(cmd, raw, null, { verbosity: "compact", exitCode: exit });
    expect(r.filterId).toBe(slug);
    expect(1 - bytes(r.output) / bytes(raw)).toBeGreaterThanOrEqual(minSaved);
    const kept = new Set(r.output.split("\n").map((l) => l.replace(/ ×\d+$/, "").trimEnd()));
    for (const line of stripAnsi(raw).split("\n")) {
      if (!line.trim() || kept.has(line.trimEnd())) continue;
      if (FAILURE_MARK.test(line) && !PASSING_SUMMARY.test(line)) expect.fail(`failure line dropped: ${line}`);
      expect(noise !== null && noise.test(line), line).toBe(true);
    }
  });

  it("uv run pytest failures go through the pytest failure summary", async () => {
    const raw = fixture("uv-pytest-fail");
    const r = await processOutput("uv run pytest", raw, null, { verbosity: "compact", exitCode: 1 });
    expect(r.filterId).toBe("pytest");
    expect(r.failureSummary).toBe(true);
    expect(r.output).toContain("test_normalize_user_rejects_empty");
    expect(r.output).toContain("assert '' == 'anonymous'");
    expect(1 - bytes(r.output) / bytes(raw)).toBeGreaterThan(0.8);
  });

  it("oc get pods keeps every unhealthy pod while dropping column padding", async () => {
    const raw = fixture("oc-get-pods");
    const r = await processOutput("oc get pods", raw, null, { verbosity: "compact", exitCode: 0 });
    expect(r.filterId).toBe("oc");
    const unhealthy = raw.split("\n").filter((l) => /CrashLoopBackOff|ImagePullBackOff|Pending|Error|OOMKilled/.test(l));
    expect(unhealthy.length).toBeGreaterThanOrEqual(3);
    for (const line of unhealthy) expect(r.output).toContain(line.trim().split(/\s+/)[0]!);
    expect(r.output).toContain("thanos-querier-5fcf655bd-4h2m2\t5/6\tCrashLoopBackOff\t14 (2m10s ago)\t16d");
    expect(r.output.split("\n")).toHaveLength(raw.split("\n").length);
    expect(1 - bytes(r.output) / bytes(raw)).toBeGreaterThan(0.45);
    const normal = await processOutput("oc get pods", raw, null, { verbosity: "normal", exitCode: 0 });
    expect(normal.output.split("\n").filter((l) => /CrashLoopBackOff/.test(l))).toHaveLength(2);
  });

  it("oc tables with an unknown shape are left as they are", async () => {
    const raw = "NAME   READY   STATUS\n  odd row starting with spaces\n";
    const r = await processOutput("oc get pods", raw, null, { verbosity: "compact", exitCode: 0 });
    expect(r.output).toBe(raw);
  });
});
