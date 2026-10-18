import { describe, expect, it } from "vitest";
import { rewrite, splitTopLevel } from "../hooks-host/pre-tool-use";

describe("rewrite never reaches inside quoted strings, substitutions or script args", () => {
  it.each([
    ['X="$(node -e "a(); b()")"'],
    ['x=$(node -e "a();b()")'],
    ['echo "$(cat f; ls)"'],
    ['echo "$(node -e "a; b")"'],
    ['echo "$(echo "$(ls; pwd)")"'],
    ['echo "`node -e "a;b"`"'],
    ["x=`node -e 'a;b'`"],
    ["bash -c \"$CMD\""],
    ["bash -c 'echo a; cd b'"],
    ["node -e 'x;y'"],
    ['node -e "x;y"'],
    ["git commit -m \"$(cat <<'EOF'\nfix; more\nEOF\n)\""],
    ["cat <<EOF\n$(ls; pwd)\nEOF"],
    ['grep $(case $x in a) echo p;; esac) f'],
    ['V="$(node -e "a()")"; W="$(node -e "b(); c()")"']
  ])("leaves %j untouched", (cmd) => {
    expect(rewrite(cmd)).toBe(cmd);
  });

  it("rewrites a top-level shell -c script inside its own quotes", () => {
    expect(rewrite("bash -c 'cat a; ls'")).toBe("tkr-exec bash -c 'tkr-exec cat a; tkr-exec ls'");
    expect(rewrite('sh -c "cd /tmp; ls"')).toBe('sh -c "cd /tmp; tkr-exec ls"');
  });

  it("wraps the outer command once without touching a nested quoted script", () => {
    expect(rewrite('grep "$(node -e "console.log(1); process.exit(0)")" f')).toBe(
      'tkr-exec grep "$(node -e "console.log(1); process.exit(0)")" f'
    );
  });

  it("wraps the outer command once without touching nested backticks", () => {
    expect(rewrite('grep "`cat p; echo x`" f')).toBe('tkr-exec grep "`cat p; echo x`" f');
  });

  it("still wraps top-level segments around a quoted substitution", () => {
    expect(rewrite('V="$(node -e "a; b")" && git status')).toBe(
      'V="$(node -e "a; b")" && tkr-exec git status'
    );
  });

  it("treats ANSI-C quoted escapes as part of the string", () => {
    expect(rewrite("grep $'it\\'s; ok' f")).toBe("tkr-exec grep $'it\\'s; ok' f");
  });

  it("does not split on separators inside a substitution nested in double quotes", () => {
    const segs = splitTopLevel('X="$(node -e "a; b")" && ls');
    expect(segs.map((s) => s.text.trim())).toEqual(['X="$(node -e "a; b")"', "&&", "ls"]);
  });

  it("sees a redirect hidden behind a quote inside a substitution", () => {
    const cmd = "grep \"$(echo '\"')\" f > out";
    expect(rewrite(cmd)).toBe(cmd);
  });
});

describe("interpreter script args nested in substitutions stay untouched", () => {
  const jsExec = "node '/x/dist/bin/tkr-exec.js'";
  const scripts: Record<string, string> = {
    python: "-c \"import os; print(os.getcwd())\"",
    python3: "-c \"import sys; print(sys.version)\"",
    node: "-e \"const a = 1; console.log(a)\"",
    ruby: "-e \"a = 1; puts a\"",
    perl: "-e \"my $a = 1; print $a\"",
    bash: "-c \"cd /tmp; ls\"",
    sh: "-c \"cd /tmp; ls\"",
    zsh: "-c \"cd /tmp; ls\""
  };
  const forms = Object.entries(scripts).flatMap(([bin, arg]) => [
    `V="$(${bin} ${arg})"`,
    `V=$(${bin} ${arg})`,
    `echo "$(${bin} ${arg})"`,
    `V="\`${bin} ${arg}\`"`,
    `V=\`${bin} ${arg}\``,
    `echo "\`${bin} ${arg}\`"`
  ]);

  it.each(forms)("leaves %j untouched", (cmd) => {
    expect(rewrite(cmd)).toBe(cmd);
    expect(rewrite(cmd, jsExec)).toBe(cmd);
  });

  it.each(Object.entries(scripts))("wraps only the outer command around a nested %s script", (bin, arg) => {
    const cmd = `grep "$(${bin} ${arg})" f`;
    expect(rewrite(cmd, jsExec)).toBe(`${jsExec} ${cmd}`);
    const tick = `grep "\`${bin} ${arg}\`" f`;
    expect(rewrite(tick, jsExec)).toBe(`${jsExec} ${tick}`);
  });
});
