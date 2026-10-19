import { afterEach, describe, expect, it } from "vitest";
import { processOutput, setFilterResolver, type LoadedFilter } from "../engine";
import { smartLs } from "../engine/transforms/smart-ls";
import { smartFind } from "../engine/transforms/smart-find";
import { collapseBlankRuns, dedupeAdjacent } from "../engine/transforms/prompt-compress";
import { truncateLinesAt } from "../engine/transforms/truncate-lines";

function filter(extra: Partial<LoadedFilter>): LoadedFilter {
  return { slug: "t", match_command: ".*", matchRegex: /.*/, priority: 1, strip_ansi: false, strip_lines_matching: [], ...extra } as LoadedFilter;
}
const run = (cmd: string, out: string, f: Partial<LoadedFilter>, exitCode?: number) =>
  processOutput(cmd, out, null, { exitCode, resolver: async () => filter(f) });

afterEach(() => setFilterResolver(null));

describe("on_empty only for exit 0 with truly empty raw output", () => {
  it("prints on_empty for exit 0 and empty output", async () => {
    expect((await run("git diff", "", { on_empty: "git diff: no changes" }, 0)).output).toBe("git diff: no changes\n");
  });
  it.each([
    ["git diff --quiet", "git diff: no changes"],
    ["black --check .", "black: ok"],
    ["find /nonexistent -name x", "find: no matches"]
  ])("does not print on_empty for exit 1: %s", async (cmd, msg) => {
    const r = await run(cmd, "", { on_empty: msg }, 1);
    expect(r.output).not.toContain(msg);
  });
  it("keeps grep's no-match placeholder on exit 1, which means nothing matched", async () => {
    expect((await run("grep foo f", "", { slug: "grep", on_empty: "grep: no match" }, 1)).output).toBe("grep: no match\n");
    expect((await run("grep -q foo f", "", { slug: "grep", on_empty: "grep: no match" }, 1)).output).not.toContain("no match");
    expect((await run("grep foo f", "", { slug: "grep", on_empty: "grep: no match" }, 2)).output).not.toContain("no match");
  });
  it("does not print on_empty when raw output is only blank lines", async () => {
    const r = await run("grep -h '^$' f", "\n\n", { on_empty: "grep: no match", strip_lines_matching: ["^$"] }, 0);
    expect(r.output).not.toContain("grep: no match");
  });
});

describe("smart-ls sort flags", () => {
  const long = [
    "total 12",
    "-rw-r--r--  1 u staff  10 Oct 19 10:00 newest.txt",
    "drwxr-xr-x  2 u staff  64 Oct 18 09:00 adir",
    "-rw-r--r--  1 u staff 900 Oct 01 08:00 oldest.log"
  ];
  it.each(["ls -lt", "ls -ltr", "ls -lS", "ls -t", "ls -tr", "ls -S", "ls -U", "ls -f", "ls -l --sort=time", "cd x && ls -lt | head"])(
    "keeps order and dates for %s",
    (cmd) => {
      expect(smartLs(long, cmd)).toEqual(long);
    }
  );
  it("still regroups without sort flags", () => {
    expect(smartLs(long, "ls -la")[0]).toContain("adir/");
    expect(smartLs(long)[0]).toContain("adir/");
  });
  it("end to end through processOutput", async () => {
    const r = await run("ls -lt", long.join("\n") + "\n", { transform: "smart-ls" }, 0);
    expect(r.output.split("\n")[1]).toContain("newest.txt");
    expect(r.output).toContain("Oct 19 10:00");
  });
});

describe("smart-find absolute paths", () => {
  it("keeps root-level absolute paths absolute", () => {
    const out = smartFind(["/x.log", "/y.log", "/a/z.log"]).join("\n");
    expect(out).toContain("/ (2");
    expect(out).not.toContain("./");
  });
  it("still shows relative root as ./", () => {
    expect(smartFind(["./x.log", "./y.log"]).join("\n")).toContain("./ (2");
  });
  it("only root-level absolute file", () => {
    const out = smartFind(["/x.log"]).join("\n");
    expect(out).toContain("/ (1");
    expect(out).not.toContain("./");
  });
});

describe("truncate_lines_at keeps JSON valid", () => {
  it("does not cut a single-line JSON document", () => {
    const doc = JSON.stringify({ body: "x".repeat(500), n: 1 });
    const [line] = truncateLinesAt([doc], 200);
    expect(line).toBe(doc);
    expect(() => JSON.parse(line!)).not.toThrow();
  });
  it("does not cut pretty-printed JSON with a long value line", () => {
    const lines = JSON.stringify({ body: "x".repeat(500) }, null, 2).split("\n");
    expect(truncateLinesAt(lines, 200)).toEqual(lines);
  });
  it("still truncates ordinary long lines", () => {
    expect(truncateLinesAt(["y".repeat(300)], 200)[0]).toHaveLength(201);
  });
});

describe("on_empty with quiet/action flags, exit codes and newline", () => {
  const ok = { on_empty: "OK-MSG" };
  it.each([
    "grep -q foo f", "grep -ql foo f", "grep --quiet foo f", "find . -name x -quit", "find . -name x -delete",
    "find . -exec rm {} ;", "ruff check -q", "black --check -q .", "eslint -o out.txt .", "prettier -l ."
  ])("no placeholder for %s", async (cmd) => {
    expect((await run(cmd, "", ok, 0)).output).not.toContain("OK-MSG");
  });
  it("no placeholder and raw kept on exit 1 for prettier -l", async () => {
    const r = await run("prettier -l .", "a.js\n", { ...ok, strip_lines_matching: ["^a"] }, 1);
    expect(r.output).toBe("a.js\n");
  });
});

describe("no gluing of placeholder / restore hint onto following output", () => {
  it("on_empty placeholder is newline-terminated so the next command's output starts a new line", async () => {
    const a = (await run("git diff", "", { on_empty: "git diff: no changes" }, 0)).output;
    expect(`${a}dirty\n`).toBe("git diff: no changes\ndirty\n");
  });
});

describe("compact verbosity keeps diff hunks intact", () => {
  const diff = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,6 +1,6 @@", " a", " ", " ", " ", "-x", "+y", " z", " z"];
  it("does not collapse whitespace-only context lines or duplicates in a diff", () => {
    expect(collapseBlankRuns(diff)).toEqual(diff);
    expect(dedupeAdjacent(diff)).toEqual(diff);
  });
  it("applies end to end at compact verbosity", async () => {
    const r = await processOutput("git diff", diff.join("\n") + "\n", null, {
      verbosity: "compact", exitCode: 0, resolver: async () => filter({ strip_lines_matching: ["^index "] })
    });
    expect(r.output).toBe(diff.join("\n") + "\n");
  });
});

describe("review follow-ups", () => {
  it("drops curl's meter redrawn on one line with carriage returns", async () => {
    const { curlProgress } = await import("../engine/transforms/curl-progress");
    const row = (p: number) => `${String(p).padStart(3)}  1256  ${String(p).padStart(3)}  1256    0     0   5321      0 --:--:-- --:--:-- --:--:--  5340`;
    const out = curlProgress([
      "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current",
      "                                 Dload  Upload   Total   Spent    Left  Speed",
      `\r${row(0)}\r${row(100)}`,
      '{"ok":true}'
    ]);
    expect(out).toEqual(['{"ok":true}']);
  });

  it("still cuts a large one-line JSON document", async () => {
    const { truncateLinesAt } = await import("../engine/transforms/truncate-lines");
    const big = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${i}` })));
    expect(truncateLinesAt([big], 200)[0]!.length).toBeLessThanOrEqual(201);
    const small = JSON.stringify({ body: "x".repeat(300) });
    expect(truncateLinesAt([small], 200)).toEqual([small]);
  });

  it("groups grep output that includes a bare file name such as Makefile", async () => {
    const { smartGrep } = await import("../engine/transforms/smart-grep");
    const lines = [...Array.from({ length: 90 }, (_, i) => `src/mod${i % 5}/file${i % 10}.ts:// TODO ${i}`), "Makefile:\t# TODO build"];
    const out = smartGrep(lines);
    expect(out[0]).toBe("91m 11f:");
    expect(out.join("\n")).toContain("Makefile");
  });

  it("still collapses whitespace-only blank runs outside diffs", async () => {
    const { collapseBlankRuns } = await import("../engine/transforms/prompt-compress");
    expect(collapseBlankRuns(["a", "   ", "\t", "", "b"])).toEqual(["a", "", "b"]);
  });
});
