import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadFilters, processOutput, selectFilter, setFilterResolver } from "../engine";
import { __resetCache } from "../engine/loader";
import { __resetMatcherCache } from "../engine/matcher";
import { routingCandidates } from "../engine/routing";
import { stripAnsi } from "../engine/transforms/strip-ansi";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/rtk10/${name}`, import.meta.url)), "utf8");
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const saved = (raw: string, out: string): number => 1 - bytes(out) / bytes(raw);
const run = (cmd: string, raw: string, exitCode: number, verbosity: "normal" | "compact" | "minimal" = "compact") =>
  processOutput(cmd, raw, null, { verbosity, exitCode });

export function expectOnlyNoiseDropped(raw: string, out: string, noise: RegExp | null): void {
  const kept = new Set(out.split("\n").map((l) => l.replace(/ ×\d+$/, "").trimEnd()));
  for (const line of stripAnsi(raw).split("\n")) {
    if (!line.trim() || kept.has(line.trimEnd())) continue;
    expect(noise !== null && noise.test(line), line).toBe(true);
  }
}

function expectEveryLineKept(raw: string, out: string): void {
  expectOnlyNoiseDropped(raw, out, null);
}

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

async function slugFor(cmd: string): Promise<string | null> {
  const filters = await loadFilters();
  for (const candidate of routingCandidates(cmd)) {
    const hit = selectFilter(candidate, filters.values(), null);
    if (hit) return hit.slug;
  }
  return null;
}

describe("rtk 1.0.1 command coverage: routing", () => {
  it.each([
    ["ruff check .", "ruff"],
    ["uv run ruff check src", "ruff"],
    ["uvx ruff check", "ruff"],
    ["ruff check --fix --diff .", null],
    ["ruff format --check .", "ruff-format"],
    ["mypy src", "mypy"],
    ["python3 -m mypy src", "mypy"],
    ["poetry run mypy .", "mypy"],
    ["dmypy run -- src", "mypy"],
    ["eslint src", "eslint"],
    ["npx eslint .", "eslint"],
    ["pnpm exec eslint --max-warnings 0 .", "eslint"],
    ["bunx eslint .", "eslint"],
    ["npx prettier --check .", "prettier"],
    ["yarn exec prettier --write src", "prettier"],
    ["rubocop", "rubocop"],
    ["bundle exec rubocop -a", "rubocop"],
    ["golangci-lint run ./...", "golangci-lint"],
    ["sqlfluff lint models --dialect postgres", "sqlfluff"],
    ["sqlfluff fix models", "sqlfluff"],
    ["ast-grep run -p 'console.log($A)' src", "ast-grep"],
    ["ast-grep -p 'foo($A)' -l ts", "ast-grep"],
    ["sg run -p 'x' src", "ast-grep"],
    ["sg --pattern 'x' src", "ast-grep"],
    ["ast-grep scan", "ast-grep-scan"],
    ["sg scan -r rules/no-console.yml", "ast-grep-scan"],
    ["sg newgrp", null],
    ["ctest --output-on-failure -j8", "ctest"],
    ["mvnd clean verify", "mvn"],
    ["mvnw -q test", "mvn"],
    ["./mvnw test", "mvn"],
    ["gradlew build", "gradle"],
    ["gradlew.bat test", "gradle"],
    ["phpunit", "phpunit"],
    ["vendor/bin/phpunit --filter Cart", "phpunit"],
    ["php vendor/bin/phpunit", "phpunit"],
    ["./vendor/bin/pest", "pest"],
    ["php vendor/bin/pest --parallel", "pest"],
    ["php artisan test", "pest"],
    ["vendor/bin/paratest -p8", "paratest"],
    ["php run-tests.php -q tests", "phpt"],
    ["php artisan migrate --force", "artisan"],
    ["vendor/bin/phpstan analyse", "phpstan"],
    ["php vendor/bin/phpstan analyse --level 8", "phpstan"],
    ["./vendor/bin/pint --test", "pint"],
    ["vendor/bin/ecs check src", "ecs"],
    ["php -l src/Cart.php", "php-lint"],
    ["pulumi up --yes", "pulumi"],
    ["pulumi preview --diff", "pulumi"],
    ["gt log", "gt"],
    ["gt submit --stack", "gt"],
    ["bunx tsc --noEmit", "tsc"],
    ["bunx cowsay hi", "bun"],
    ["uv run pytest -q", "pytest"],
    ["python3 -m pytest -q", "pytest"],
    ["uv run main.py", "uv"],
    ["uv sync", "uv"],
    ["git show HEAD:src/cart.ts", "git-show-blob"],
    ["git show main:README.md", "git-show-blob"],
    ["git show HEAD", "git-diff"],
    ["git show --stat HEAD~1", "git-diff"],
    ["oc get pods", "oc"],
    ["deno test -A", "deno"],
    ["bun test", "bun-test"],
    ["bun test --bail src", "bun-test"],
    ["oc get pods -A", "oc"]
  ])("%s → %s", async (cmd, slug) => {
    expect(await slugFor(cmd)).toBe(slug);
  });
});

describe("success output is compressed and keeps its result", () => {
  it("ctest keeps the totals and drops every passing test", async () => {
    const raw = fixture("ctest-ok.txt");
    const r = await run("ctest", raw, 0);
    expect(r.output).toBe("Test project /home/dev/shop/build\n100% tests passed out of 14\nTotal Test time (real) =   0.04 sec\n");
    expect(saved(raw, r.output)).toBeGreaterThan(0.9);
  });

  it("pest keeps only the totals", async () => {
    const raw = fixture("pest-ok.txt");
    const r = await run("./vendor/bin/pest", raw, 0);
    expect(r.output.trim()).toBe("Tests:    18 passed (18 assertions)\n  Duration: 0.05s");
    expect(saved(raw, r.output)).toBeGreaterThan(0.9);
  });

  it("phpunit and paratest keep the banner and the OK line", async () => {
    for (const [file, cmd] of [["phpunit-ok.txt", "php vendor/bin/phpunit"], ["paratest-ok.txt", "vendor/bin/paratest"]] as const) {
      const raw = fixture(file);
      const r = await run(cmd, raw, 0);
      expect(r.output).toContain("OK (24 tests, 24 assertions)");
      expect(r.output).toContain("by Sebastian Bergmann and contributors.");
      expect(r.output).not.toMatch(/^\.+\s+24 \/ 24/m);
      expect(saved(raw, r.output)).toBeGreaterThan(0.5);
    }
  });

  it("phpt keeps the result summary and skip reasons", async () => {
    const raw = fixture("phpt-ok.txt");
    const r = await run("php run-tests.php -q tests", raw, 0);
    expect(r.output).toContain("SKIP money_format(): intl collation [tests/041.phpt] reason: intl extension not loaded");
    expect(r.output).toContain("Tests passed    :   40 ( 97.6%) (100.0%)");
    expect(r.output).toContain("Tests failed    :    0 (  0.0%) (  0.0%)");
    expect(r.output).not.toContain("PASS money_format()");
    expect(r.output).not.toContain("PHP_VERSION");
    expect(saved(raw, r.output)).toBeGreaterThan(0.9);
  });

  it("sqlfluff drops passing files and banners", async () => {
    const raw = fixture("sqlfluff-lint-ok.txt");
    const r = await run("sqlfluff lint sql -v --dialect ansi", raw, 0);
    expect(r.output).not.toContain("] PASS");
    expect(r.output).toContain("violations:        0");
    expect(saved(raw, r.output)).toBeGreaterThan(0.9);
  });

  it("prettier --write lists only the files it changed", async () => {
    const raw = fixture("prettier-write.txt");
    const r = await run("pnpm exec prettier --write src", raw, 0);
    expect(r.output.trim()).toBe("src2/ugly.js 0ms");
    const clean = raw.split("\n").filter((l) => l.includes("(unchanged)")).join("\n");
    expect((await run("prettier --write src", clean, 0)).output).toBe("prettier: all files unchanged");
  });

  it("golangci-lint drops info logs and keeps the verdict", async () => {
    const raw = fixture("golangci-lint-ok.txt");
    const r = await run("golangci-lint run -v", raw, 0);
    expect(r.output.trim()).toBe("0 issues.");
    expect(saved(raw, r.output)).toBeGreaterThan(0.95);
  });

  it("rubocop drops progress dots and keeps the summary", async () => {
    const r = await run("bundle exec rubocop", fixture("rubocop-ok.txt"), 0);
    expect(r.output.trim()).toBe("184 files inspected, no offenses detected");
  });

  it("phpstan, pint and ecs drop progress bars and keep the verdict", async () => {
    const stan = await run("vendor/bin/phpstan analyse", fixture("phpstan-ok.txt"), 0);
    expect(stan.output.trim()).toBe("[OK] No errors");
    const pint = await run("./vendor/bin/pint --test", fixture("pint-ok.txt"), 0);
    expect(pint.output).toContain("PASS");
    expect(pint.output).toContain("31 files");
    expect(pint.output).not.toMatch(/^\s*\.+\s*$/m);
    const ecs = await run("vendor/bin/ecs check src", fixture("ecs-ok.txt"), 0);
    expect(ecs.output).toContain("[OK] No errors found.");
    expect(ecs.output).not.toContain("17/17 [");
  });

  it("deno test keeps the summary line", async () => {
    const r = await run("deno test", fixture("deno-test-ok.txt"), 0);
    expect(r.output.trim()).toBe("ok | 7 passed | 0 failed (18ms)");
  });

  it("bun test drops passing tests", async () => {
    const raw = fixture("bun-test-ok.txt");
    const r = await run("bun test", raw, 0);
    expect(r.output).not.toContain("(pass)");
    expect(r.output).toContain("Ran 24 tests across 3 files.");
    expect(saved(raw, r.output)).toBeGreaterThan(0.7);
  });

  it("maven daemon output keeps test counts, reactor summary and verdict", async () => {
    const raw = fixture("mvnd-ok.txt");
    const r = await run("mvnd clean verify", raw, 0);
    for (const line of [
      "[INFO] Tests run: 33, Failures: 0, Errors: 0, Skipped: 0",
      "[INFO] shop-core .......................................... SUCCESS [  3.418 s]",
      "[INFO] BUILD SUCCESS",
      "[INFO] Total time:  4.902 s (Wall Clock)"
    ]) expect(r.output).toContain(line);
    expect(r.output).not.toContain("--- compiler:3.13.0:compile");
    expect(r.output).not.toContain("Processing build on daemon");
    expect(saved(raw, r.output)).toBeGreaterThan(0.65);
  });

  it("pulumi keeps resource changes, outputs and counts, drops progress and links", async () => {
    const raw = fixture("pulumi-up-ok.txt");
    const r = await run("pulumi up --yes", raw, 0);
    expect(r.output).toContain(" +   ├─ aws:s3:BucketV2                assets                created (2s)");
    expect(r.output).toContain("updated (4s)        [diff: ~code]");
    expect(r.output).toContain("  ~ apiUrl    :");
    expect(r.output).toContain("    + 2 created");
    expect(r.output).toContain("    3 changes. 14 unchanged");
    expect(r.output).not.toContain("creating (");
    expect(r.output).not.toContain("View in Browser");
    expect(saved(raw, r.output)).toBeGreaterThan(0.45);
    const preview = await run("pulumi preview", fixture("pulumi-preview-ok.txt"), 0);
    expect(preview.output).toContain(" -   └─ aws:sqs:Queue                  legacy-orders         delete");
    expect(preview.output).toContain("    - 1 to delete");
  });

  it("uv sync drops resolver chatter and keeps installed packages", async () => {
    const raw = fixture("uv-sync-ok.txt");
    const r = await run("uv sync", raw, 0);
    expect(r.output).toContain("Installed 18 packages in 17ms");
    expect(r.output).toContain(" + pydantic==2.9.2");
    expect(r.output).not.toContain("Resolved 20 packages");
    expect(r.output).not.toContain("Creating virtual environment");
  });

  it("php -l collapses a clean lint", async () => {
    expect((await run("php -l src/F1.php", "No syntax errors detected in src/F1.php\n", 0)).output).toBe("php -l: no syntax errors");
  });

  it("git show of a blob is read like a file", async () => {
    const source = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    const r = await run("git show HEAD:src/values.ts", source, 0);
    expect(r.filterId).toBe("git-show-blob");
    expect(r.output).toBe(source);
  });
});

describe("findings and failures stay fully visible", () => {
  it.each([
    ["ctest-fail.txt", "ctest", 8, /^\s+Start\s+\d+: |\s+Passed\s+[\d.]+ sec$/],
    ["pest-fail.txt", "php artisan test", 1, /^\s*✓ |^\s*PASS\s+\S/],
    ["phpt-fail.txt", "php run-tests.php -q tests", 1, /^PASS .*\.phpt\]\s*$|^(?:PHP|PHP_SAPI|PHP_VERSION|ZEND_VERSION|PHP_OS|INI actual|More \.INIs|CWD|Extra dirs|VALGRIND)\s*:|^TIME (?:START|END) |^Exts (?:skipped|tested)|^[=-]{20,}$/],
    ["phpstan-fail.txt", "vendor/bin/phpstan analyse", 1, /^\s*\d+\/\d+ \[|^Note: Using configuration file |^\s*-{3,}\s+-{3,}\s*$/],
    ["bun-test-fail.txt", "bun test", 1, /^\(pass\) /],
    ["pulumi-up-fail.txt", "pulumi up --yes", 255, /^@ |^View in Browser|^\s*Type\s+Name\s+(?:Status|Plan)/]
  ])("%s drops only passing noise", async (file, cmd, exit, noise) => {
    for (const verbosity of ["normal", "compact"] as const) {
      const raw = fixture(file);
      const r = await run(cmd, raw, exit, verbosity);
      expect(r.debugBypass).toBe(true);
      expectOnlyNoiseDropped(raw, r.output, noise);
    }
  });

  it.each([
    ["pint-test-fail.txt", "./vendor/bin/pint --test", 1],
    ["php-lint-fail.txt", "php -l src/Bad.php", 255],
    ["sqlfluff-lint-fail.txt", "sqlfluff lint sql/bad.sql", 1],
    ["ast-grep-scan-fail.txt", "ast-grep scan", 1],
    ["golangci-lint-fail.txt", "golangci-lint run", 1],
    ["rubocop-fail.txt", "bundle exec rubocop", 1],
    ["uv-sync-fail.txt", "uv sync", 1],
    ["mypy-fail.txt", "mypy app.py", 1]
  ])("%s keeps every line", async (file, cmd, exit) => {
    for (const verbosity of ["normal", "compact"] as const) {
      const raw = fixture(file);
      const r = await run(cmd, raw, exit, verbosity);
      expectEveryLineKept(raw, r.output);
    }
  });

  it("prettier --check findings keep every file to fix and the verdict", async () => {
    const raw = fixture("prettier-check-fail.txt");
    const r = await run("npx prettier --check src", raw, 1);
    for (const line of raw.split("\n").filter((l) => l.startsWith("[warn]"))) expect(r.output).toContain(line);
  });

  it("eslint findings keep every problem with its file and the total", async () => {
    const raw = fixture("eslint-fail.txt");
    const r = await run("npx eslint src", raw, 1);
    expect(r.filterId).toBe("eslint");
    expectEveryLineKept(raw, r.output);
  });

  it("ruff findings keep every rule, location, help and total while dropping source snippets", async () => {
    for (const file of ["ruff-check-fail.txt", "ruff-check-legacy-fail.txt"]) {
      const raw = fixture(file);
      const r = await run("ruff check .", raw, 1);
      const essential = raw.split("\n").filter((l) => /^[A-Z]+\d+ |^\S+:\d+:\d+: [A-Z]+\d+ |-->|help:|^Found \d+ error|fixable/.test(l));
      expect(essential.length).toBeGreaterThan(8);
      for (const line of essential) expect(r.output).toContain(line.trim());
      expect(r.output).not.toMatch(/^\s*\d*\s*\|/m);
      expect(saved(raw, r.output)).toBeGreaterThan(0.4);
    }
  });

  it("a ruff failure that is not a finding (exit 2) is left complete", async () => {
    const raw = fixture("ruff-check-fail.txt");
    const r = await run("ruff check .", raw, 2);
    expect(r.output).toBe(raw);
  });
});

describe("huge outputs", () => {
  const ctestLines = (n: number, failed: number[]) => {
    const out = ["Test project /home/dev/shop/build"];
    for (let i = 1; i <= n; i++) {
      out.push(`      Start ${String(i).padStart(4)}: case_${i}`);
      const status = failed.includes(i) ? "***Failed" : "   Passed";
      out.push(`${String(i).padStart(4)}/${n} Test  #${i}: case_${i} ...........${status}    0.01 sec`);
    }
    const pct = Math.floor(((n - failed.length) / n) * 100);
    out.push("", failed.length ? `${pct}% tests passed, ${failed.length} tests failed out of ${n}` : `100% tests passed out of ${n}`, "", "Total Test time (real) =  12.40 sec");
    if (failed.length) out.push("", "The following tests FAILED:", ...failed.map((i) => `\t${String(i).padStart(4)} - case_${i} (Failed)`), "Errors while running CTest");
    return out.join("\n") + "\n";
  };

  it("ctest with 3000 passing tests shrinks to the totals", async () => {
    const raw = ctestLines(3000, []);
    const r = await run("ctest -j16", raw, 0);
    expect(r.output).toContain("100% tests passed out of 3000");
    expect(saved(raw, r.output)).toBeGreaterThan(0.99);
  });

  it("ctest with 3000 tests and 2 failures keeps both failures and every summary line", async () => {
    const raw = ctestLines(3000, [17, 2999]);
    const r = await run("ctest -j16", raw, 8);
    expect(r.debugBypass).toBe(true);
    expect(r.output).toContain("  17/3000 Test  #17: case_17 ...........***Failed    0.01 sec");
    expect(r.output).toContain("2999/3000 Test  #2999: case_2999 ...........***Failed    0.01 sec");
    expect(r.output).toContain("The following tests FAILED:");
    expect(r.output).toContain("\t2999 - case_2999 (Failed)");
    expect(r.output).toContain("Errors while running CTest");
    expect(r.output).not.toContain("   Passed    ");
    expect(saved(raw, r.output)).toBeGreaterThan(0.99);
  });

  it("sqlfluff over 4000 clean files collapses", async () => {
    const raw = Array.from({ length: 4000 }, (_, i) => `== [models/m${i}.sql] PASS`).join("\n") + "\nAll Finished!\n";
    const r = await run("sqlfluff lint models", raw, 0);
    expect(r.output).toBe("sqlfluff: no violations");
  });

  it("prettier --write over 6000 files keeps the 3 it changed", async () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `src/f${i}.ts ${i % 7}ms (unchanged)`);
    lines.splice(10, 0, "src/a.ts 12ms");
    lines.splice(3000, 0, "src/b.ts 4ms");
    lines.push("src/c.ts 1ms");
    const raw = lines.join("\n") + "\n";
    const r = await run("npx prettier --write src", raw, 0);
    expect(r.output.trim().split("\n")).toEqual(["src/a.ts 12ms", "src/b.ts 4ms", "src/c.ts 1ms"]);
  });

  it("pest with 2000 passing tests keeps the totals", async () => {
    const body = Array.from({ length: 200 }, (_, f) => [`   PASS  Tests\\Unit\\Case${f}Test`, ...Array.from({ length: 10 }, (_, t) => `  ✓ it handles case ${f}.${t}`), ""]).flat();
    const raw = ["", ...body, "  Tests:    2000 passed (2400 assertions)", "  Duration: 4.21s", ""].join("\n");
    const r = await run("vendor/bin/pest", raw, 0);
    expect(r.output.trim()).toBe("Tests:    2000 passed (2400 assertions)\n  Duration: 4.21s");
  });

  it("ast-grep with 4000 matches groups matches by file", async () => {
    const raw = Array.from({ length: 4000 }, (_, i) => `src/mod${i % 40}/file${i % 400}.ts:${(i % 90) + 1}:  console.log("value", x${i});`).join("\n") + "\n";
    const r = await run("ast-grep run -p 'console.log($$$A)' src", raw, 0);
    expect(r.filterId).toBe("ast-grep");
    expect(saved(raw, r.output)).toBeGreaterThan(0.6);
    expect(r.output).toMatch(/mod\d+\/file\d+\.ts \(10\)/);
  });

  it("composer and uv chatter on large installs is compressed", async () => {
    const raw = fixture("composer-require.txt");
    const r = await run("composer require --dev pestphp/pest", raw, 0);
    expect(saved(raw, r.output)).toBeGreaterThan(0.6);
  });
});
