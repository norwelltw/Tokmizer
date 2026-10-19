import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFilters, processOutput, selectFilter, setFilterResolver } from "../engine";
import { __resetCache } from "../engine/loader";
import { __resetMatcherCache } from "../engine/matcher";
import { routingCandidates } from "../engine/routing";
import { smartGrep } from "../engine/transforms/smart-grep";
import { getTransform } from "../engine/transforms/registry";

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
  for (const c of routingCandidates(cmd)) {
    const hit = selectFilter(c, filters.values(), null);
    if (hit) return hit.slug;
  }
  return null;
}
const run = (cmd: string, raw: string, exitCode = 0, verbosity: "normal" | "compact" | "minimal" = "normal") =>
  processOutput(cmd, raw, null, { verbosity, exitCode });

describe("smart-grep keeps non-path prefixes in order", () => {
  it("leaves log lines with ERROR: / timestamps alone", () => {
    const a = ["ERROR: one", "WARN: two", "ERROR: three", "12:34:56 ERROR x", "12:34:57 ERROR y"];
    expect(smartGrep(a)).toEqual(a);
    const b = Array.from({ length: 30 }, (_, i) => `ERROR: failure ${i}`);
    expect(smartGrep(b)).toEqual(b);
  });
  it("leaves git log | grep Author: and kubectl | grep my-app alone", () => {
    const a = ["Author: A <a@x>", "Author: B <b@x>", "Author: A <a@x>"];
    expect(smartGrep(a)).toEqual(a);
    const k = ["my-app-2-1 running", "my-app-3-1 running", "my-app-2-1 pending"];
    expect(smartGrep(k)).toEqual(k);
  });
  it("still groups real path:line: output", () => {
    const out = smartGrep(["src/a.ts:1:x", "src/a.ts:2:y", "src/b.ts:3:z"]);
    expect(out[0]).toBe("3m 2f in src/:");
  });
});

describe("smart-grep-ast counts matches, keeps indentation", () => {
  const ast = getTransform("smart-grep-ast")!;
  it("counts runs of consecutive lines as one match", () => {
    const input = [
      "src/a.ts:10:  foo(", "src/a.ts:11:    1,", "src/a.ts:12:  )",
      "src/a.ts:40:  foo(2)",
      "src/b.ts:5:foo(3)"
    ];
    const out = ast(input);
    expect(out[0]).toBe("3m 2f in src/:");
    expect(out.some((l) => l.includes("    1,"))).toBe(true);
  });
  it("one match with context lines is 1m", () => {
    const input = ["a/x.ts:1:a", "a/x.ts:2:b", "a/x.ts:3:  target()", "a/x.ts:4:c", "a/x.ts:5:d"];
    expect(ast(input)[0]).toBe("1m 1f:");
  });
});

describe("curl keeps the body", () => {
  const body = ["- bullet", "* star bullet", "> quoted", "< lt", "", "1 2 3 4 5 6 7 8", "{\"a\":1}"];
  it("leaves a plain body untouched", async () => {
    const r = await run("curl https://x", body.join("\n") + "\n");
    expect(r.output).toBe(body.join("\n") + "\n");
  });
  it("drops the progress meter only", async () => {
    const raw = [
      "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current",
      "                                 Dload  Upload   Total   Spent    Left  Speed",
      "100  1256  100  1256    0     0   5321      0 --:--:-- --:--:-- --:--:--  5340",
      ...body
    ].join("\n") + "\n";
    expect((await run("curl https://x", raw)).output).toBe(body.join("\n") + "\n");
  });
  it("drops verbose trace lines but keeps body lines", async () => {
    const raw = ["* Trying 1.2.3.4:443...", "* Connected to x (1.2.3.4) port 443", "> GET / HTTP/2", "> Host: x", ">", "< HTTP/2 200", "< content-type: text/plain", "<", "< quoted body", "- bullet"].join("\n") + "\n";
    const out = (await run("curl -v https://x", raw)).output;
    expect(out).toContain("< quoted body");
    expect(out).toContain("- bullet");
    expect(out).not.toContain("Trying");
    expect(out).not.toContain("Host: x");
  });
});

describe("git global options", () => {
  it.each([
    "git -C /repo diff", "git --no-pager diff", "git -c k=v diff", "git --git-dir=x log",
    "git -C /repo -c a=b --no-pager diff --stat", "git --git-dir x --work-tree y diff"
  ])("routes %s like the subcommand", async (cmd) => {
    const sub = cmd.includes("log") ? "git-log" : "git-diff";
    expect(await slugFor(cmd)).toBe(sub);
  });
  it("keeps blank diff context lines (generic git and git-log)", async () => {
    const diff = "@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n";
    expect((await run("git stash show -p", diff)).output).toBe(diff);
    expect((await run("git log -p", "commit " + "a".repeat(40) + "\nAuthor: A <a@x>\nDate:   Mon Jan 1 00:00:00 2024 +0000\n\n    msg\n\n" + diff)).output).toContain("\n \n-b");
    expect((await run("git cat-file -p HEAD", diff)).output).toBe(diff);
  });
  it("git-log keeps Co-Authored-By and Signed-off-by trailers", async () => {
    const raw = "commit " + "b".repeat(40) + "\nAuthor: A <a@x>\nDate:   Mon Jan 1 00:00:00 2024 +0000\n\n    msg\n\n    Co-Authored-By: B <b@x>\n    Signed-off-by: C <c@x>\n";
    const out = (await run("git log", raw)).output;
    expect(out).toContain("Co-Authored-By: B <b@x>");
    expect(out).toContain("Signed-off-by: C <c@x>");
  });
});

describe("other filters do not eat program output", () => {
  it("python keeps Downloading / Using cached lines", async () => {
    const raw = "Downloading data...\nUsing cached model\nRequirement already satisfied: x\n";
    expect((await run("python script.py", raw)).output).toBe(raw);
  });
  it("docker keeps Loaded plugin log lines", async () => {
    const raw = "app: Loaded plugin foo\n";
    expect((await run("docker logs app", raw)).output).toContain("Loaded plugin foo");
  });
  it("cargo run keeps program stdout, drops cargo status lines", async () => {
    const raw = "   Compiling foo v0.1.0\n    Finished dev profile\n     Running `target/debug/foo`\nUpdating index\nDownloading data\nFresh start\n";
    const out = (await run("cargo run", raw)).output;
    expect(out).toContain("Updating index");
    expect(out).toContain("Downloading data");
    expect(out).toContain("Fresh start");
    expect(out).not.toContain("Compiling");
    expect(out).not.toContain("Running `");
  });
  it("dig keeps the NXDOMAIN status header", async () => {
    const raw = ";; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 1\n;; flags: qr rd ra;\n;; Query time: 5 msec\n";
    const out = (await run("dig nope.example", raw)).output;
    expect(out).toContain("status: NXDOMAIN");
    expect(out).not.toContain("Query time");
  });
  it("next filter only matches real next invocations", async () => {
    for (const c of ["npm run build", "pnpm build", "pnpm run build", "pnpm dev", "npm run dev"]) expect(await slugFor(c)).not.toBe("next");
    for (const c of ["next build", "npx next build", "pnpm exec next dev"]) expect(await slugFor(c)).toBe("next");
  });
});
