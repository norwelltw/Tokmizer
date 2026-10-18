import { stripAnsi } from "./transforms/strip-ansi";
import { omissionMarker } from "./transforms/max-lines";

type Level = "normal" | "compact" | "minimal";
type Kind = "msg" | "legend" | "diff" | "frame" | "code" | "source" | "out";
type Entry = { kind: Kind; text: string; num?: number; pointed?: boolean; segment?: number };
type Failure = { file: string | null; name: string; loc: string | null; body: Entry[]; exact?: boolean };
type SummaryLine = { text: string; minor: boolean };
type Parsed = { failures: Failure[]; summary: SummaryLine[]; reported: number | null; counted: number };

export const TEST_COMMAND_RE =
  /^(?:(?:npx|bunx|pnpm(?:\s+(?:exec|dlx))?|yarn(?:\s+exec)?|uv\s+run|poetry\s+run|pipenv\s+run|hatch\s+run|python3?\s+-m)\s+)?(?:\S*\/)?(?:vitest|jest|mocha|pytest|py\.test|playwright\s+test)(?:\s|$)|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?:[:-]\S+)?(?:\s|$)|^cargo\s+test(?:\s|$)|^go\s+test(?:\s|$)/;

const LIMITS: Record<Level, { msg: number; diff: number; frames: number; out: number; bulk: number; repeats: number; trimDiff: boolean; changedOnly: boolean }> = {
  normal: { msg: 40, diff: 60, frames: 6, out: 20, bulk: 50, repeats: 10, trimDiff: false, changedOnly: false },
  compact: { msg: 12, diff: 24, frames: 2, out: 5, bulk: 20, repeats: 2, trimDiff: true, changedOnly: false },
  minimal: { msg: 6, diff: 8, frames: 0, out: 0, bulk: 10, repeats: 1, trimDiff: true, changedOnly: true }
};

const LIBRARY_PATH_RE = /node_modules|^node:|^internal\/|site-packages|dist-packages|\/lib\/python\d|\/rustc\/|\.cargo\/registry|\.rustup\/|\/go\/src\/|\/go\/pkg\/mod\/|\/libexec\/src\/|<anonymous>/;
const JS_FRAME_RE = /^\s*at\s+(?:.*?\()?((?:file:\/\/)?[^\s()]+?):(\d+)(?::(\d+))?\)?\s*$/;
const VITEST_FRAME_RE = /^\s*❯\s+(?:\S+\s+)?([^\s]+?):(\d+)(?::(\d+))?\s*$/;
const CODE_LINE_RE = /^\s*(>)?\s*(\d+)\s*\|/;
const CARET_LINE_RE = /^\s*\|\s*[\^~]+\s*$/;
const LEGEND_RE = /^(?:- Expected|\+ Received|- Snapshot|\+ expected - actual|\+ actual - expected|- expected \+ actual)(?:\s+[-+]\s*\d+)?$/;

function countMatches(lines: string[], re: RegExp): number | null {
  let total: number | null = null;
  for (const line of lines) {
    const m = re.exec(line);
    if (m) total = (total ?? 0) + Number(m[1]);
  }
  return total;
}

function libraryPath(path: string): boolean {
  return LIBRARY_PATH_RE.test(path);
}

function addFrame(body: Entry[], at: string, loc: string | null): string {
  if (loc === null) return at;
  if (at !== loc && !body.some((e) => e.kind === "frame" && e.text === at)) body.push({ kind: "frame", text: at });
  return loc;
}

function classifyJs(lines: string[], isOut: (line: string) => boolean = () => false): { body: Entry[]; loc: string | null } {
  const body: Entry[] = [];
  let loc: string | null = null;
  let segment = -1;
  let out = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t || CARET_LINE_RE.test(line) || /^─+$/.test(t)) continue;
    if (isOut(t)) {
      out = true;
      body.push({ kind: "out", text: t.replace(/\s*─+$/, "") });
      continue;
    }
    if (out) {
      body.push({ kind: "out", text: t });
      continue;
    }
    const frame = JS_FRAME_RE.exec(line) ?? VITEST_FRAME_RE.exec(line);
    if (frame) {
      segment = -1;
      const path = frame[1]!.replace(/^file:\/\//, "");
      if (!libraryPath(path)) loc = addFrame(body, `${path}:${frame[2]}${frame[3] ? `:${frame[3]}` : ""}`, loc);
      continue;
    }
    const code = CODE_LINE_RE.exec(line);
    if (code) {
      segment = -1;
      body.push({ kind: "code", text: t, num: Number(code[2]), pointed: code[1] === ">" });
      continue;
    }
    if (LEGEND_RE.test(t)) {
      segment = body.length;
      body.push({ kind: "legend", text: t });
      continue;
    }
    body.push(segment >= 0 ? { kind: "diff", text: line, segment } : { kind: "msg", text: t });
  }
  const pointed = body.some((e) => e.kind === "code" && e.pointed);
  const locLine = loc ? Number(/:(\d+)(?::\d+)?$/.exec(loc)?.[1]) : NaN;
  let keptCode = false;
  const kept = body.filter((e) => {
    if (e.kind !== "code") return true;
    const keep = !keptCode && (pointed ? e.pointed === true : e.num === locLine);
    if (keep) keptCode = true;
    return keep;
  });
  const indent = new Map<number, number>();
  for (const e of kept) {
    if (e.kind !== "diff") continue;
    const width = e.text.length - e.text.trimStart().length;
    indent.set(e.segment!, Math.min(indent.get(e.segment!) ?? width, width));
  }
  for (const e of kept) {
    if (e.kind === "diff") e.text = e.text.slice(indent.get(e.segment!) ?? 0);
    if (e.kind === "code") {
      e.kind = "source";
      e.text = e.text.replace(/^>\s*/, "");
    }
  }
  return { body: kept, loc };
}

function summaryLine(text: string, minor = false): SummaryLine {
  return { text: text.trim().replace(/\s{2,}/g, " "), minor };
}

function parseVitest(lines: string[]): Parsed | null {
  if (!lines.some((l) => /^⎯+ Failed (?:Tests|Suites) \d+ ⎯+$/.test(l.trim()) || /^\s*Test Files\s{2,}\d/.test(l) || /^ ?FAIL\s+\S+ > /.test(l))) return null;
  const reported = countMatches(lines, /^\s*Tests\s+(\d+) failed/);
  const summary: SummaryLine[] = [];
  for (const line of lines) {
    if (/^\s*Test Files\s{2,}\S/.test(line)) summary.push(summaryLine(line, true));
    else if (/^\s*(?:Tests|Errors|Type Errors)\s{2,}\S/.test(line)) summary.push(summaryLine(line));
  }
  const failures: Failure[] = [];
  let counted = 0;
  let current: Failure[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (current.length) {
      const { body, loc } = classifyJs(buf);
      for (const f of current) {
        f.body = body;
        f.loc = loc;
      }
    }
    current = [];
    buf = [];
  };
  for (const line of lines) {
    const t = line.trim();
    const fail = /^ ?FAIL\s+(\S.*?)\s*$/.exec(line);
    if (fail) {
      if (buf.some((l) => l.trim())) flush();
      const title = fail[1]!;
      const suite = /^(\S+) \[ \S+ \]$/.exec(title);
      const parts = title.split(" > ");
      const f: Failure = suite
        ? { file: suite[1]!, name: "(suite)", loc: null, body: [] }
        : parts.length > 1
          ? { file: parts[0]!, name: parts.slice(1).join(" > "), loc: null, body: [] }
          : { file: null, name: title, loc: null, body: [] };
      if (!suite) counted += 1;
      failures.push(f);
      current.push(f);
      continue;
    }
    const unhandled = /^⎯+ (Unhandled [A-Za-z ]+?) ⎯+$/.exec(t);
    if (unhandled) {
      flush();
      const f: Failure = { file: null, name: unhandled[1]!, loc: null, body: [] };
      failures.push(f);
      current.push(f);
      continue;
    }
    if (/^⎯{3,}/.test(t) || /^(?:Test Files|Tests|Start at|Duration|Errors)\s{2,}/.test(t)) {
      flush();
      continue;
    }
    if (current.length) buf.push(line);
  }
  flush();
  if (counted === 0) {
    let file: string | null = null;
    for (const line of lines) {
      const header = /^\s*[❯✓×✗]\s+(\S+)\s+\(\d+ tests?\b/.exec(line);
      if (header) {
        file = header[1]!;
        continue;
      }
      const x = /^\s+[×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/.exec(line);
      if (x) {
        failures.push({ file, name: x[1]!, loc: null, body: [] });
        counted += 1;
      }
    }
  }
  return { failures, summary, reported, counted };
}

function parseJest(lines: string[]): Parsed | null {
  if (!lines.some((l) => /^\s{2}● (?!Console$)/.test(l)) || !lines.some((l) => /^Tests:\s/.test(l) || /^(?:FAIL|PASS)\s+\S/.test(l))) return null;
  const reported = countMatches(lines, /^Tests:\s+(\d+) failed/);
  const summary: SummaryLine[] = [];
  for (const line of lines) {
    if (/^Test Suites:\s/.test(line)) summary.push(summaryLine(line, true));
    else if (/^Tests:\s/.test(line) || (/^Snapshots:\s/.test(line) && /failed|obsolete/.test(line))) summary.push(summaryLine(line));
  }
  const failures: Failure[] = [];
  const keys = new Set<string>();
  let counted = 0;
  let file: string | null = null;
  let cur: Failure | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur) {
      const key = `${cur.file}\u0000${cur.name}`;
      if (!keys.has(key)) {
        keys.add(key);
        const { body, loc } = classifyJs(buf);
        cur.body = body;
        cur.loc = loc;
        failures.push(cur);
        if (cur.name !== "Test suite failed to run") counted += 1;
      }
    }
    cur = null;
    buf = [];
  };
  for (const line of lines) {
    const header = /^(?:FAIL|PASS)\s+(\S+)/.exec(line);
    if (header) {
      flush();
      file = header[1]!;
      continue;
    }
    if (/^(?:Summary of all failing tests|Test Suites:|Tests:|Snapshots:|Time:|Ran all test suites)/.test(line)) {
      flush();
      continue;
    }
    const block = /^\s{2}● (.+)$/.exec(line);
    if (block) {
      flush();
      if (block[1]!.trim() !== "Console") cur = { file, name: block[1]!.trim(), loc: null, body: [] };
      continue;
    }
    if (cur) buf.push(line);
  }
  flush();
  return { failures, summary, reported, counted };
}

function parseNumbered(lines: string[], start: number, end: number, title: (header: string, next: string[]) => { name: string; used: number }, isOut?: (line: string) => boolean): Failure[] {
  const failures: Failure[] = [];
  const byName = new Map<string, string[]>();
  let buf: string[] | null = null;
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    const header = /^\s{2}\d+\) (.+)$/.exec(line);
    if (header) {
      const { name, used } = title(header[1]!, lines.slice(i + 1, Math.min(end, i + 8)));
      i += used;
      buf = byName.get(name) ?? null;
      if (!buf) {
        buf = [];
        byName.set(name, buf);
        failures.push({ file: null, name, loc: null, body: [] });
      }
      continue;
    }
    if (/^\s+Retry #\d+ ─*/.test(line)) continue;
    if (buf) buf.push(line);
  }
  for (const f of failures) {
    const { body, loc } = classifyJs(byName.get(f.name)!, isOut);
    f.body = body;
    f.loc = loc;
  }
  return failures;
}

function parseMocha(lines: string[]): Parsed | null {
  const start = lines.findIndex((l) => /^\s*\d+ failing$/.test(l));
  if (start < 0) return null;
  const reported = Number(/(\d+)/.exec(lines[start]!)![1]);
  const summary = lines
    .filter((l) => /^\s*\d+ (?:passing|failing|pending)(?: \(\S+\))?$/.test(l))
    .map((l) => summaryLine(l.replace(/ \(\S+\)\s*$/, "")));
  const failures = parseNumbered(lines, start + 1, lines.length, (header, next) => {
    const parts = [header.trim()];
    let used = 0;
    while (!parts[parts.length - 1]!.endsWith(":") && used < next.length && next[used]!.trim()) {
      parts.push(next[used]!.trim());
      used += 1;
    }
    if (!parts[parts.length - 1]!.endsWith(":")) return { name: header.trim(), used: 0 };
    return { name: parts.join(" › ").replace(/:$/, ""), used };
  });
  return { failures, summary, reported, counted: failures.length };
}

function parsePlaywright(lines: string[]): Parsed | null {
  const first = lines.findIndex((l) => /^\s{2}\d+\) .*›.*─{3,}\s*$/.test(l));
  if (first < 0) return null;
  const tail = lines.findIndex((l, i) => i > first && /^\s{2}\d+ (?:failed|flaky|passed|skipped|interrupted|did not run)(?: \(.+\))?$/.test(l));
  const end = tail < 0 ? lines.length : tail;
  const reported = countMatches(lines.slice(end), /^\s{2}(\d+) failed$/);
  const summary = lines
    .slice(end)
    .filter((l) => /^\s{2}\d+ (?:failed|flaky|passed|skipped|interrupted|did not run)(?: \(.+\))?$/.test(l))
    .map((l) => summaryLine(l.replace(/ \([\d.]+m?s\)\s*$/, "")));
  const failures = parseNumbered(
    lines,
    first,
    end,
    (header) => ({ name: header.replace(/\s*─+\s*$/, "").trim(), used: 0 }),
    (line) => /^attachment #\d+:/.test(line)
  );
  return { failures, summary, reported, counted: failures.length };
}

function parseCargo(lines: string[]): Parsed | null {
  if (!lines.some((l) => /^test result: /.test(l)) || !lines.some((l) => /^---- .+ stdout ----$/.test(l))) return null;
  const reported = countMatches(lines, /^test result: FAILED\. \d+ passed; (\d+) failed/);
  const summary: SummaryLine[] = [];
  for (const line of lines) {
    if (/^test result: FAILED/.test(line)) summary.push(summaryLine(line.replace(/; finished in [\d.]+m?s\s*$/, "")));
    else if (/^test result: ok/.test(line)) summary.push(summaryLine(line.replace(/; finished in [\d.]+m?s\s*$/, ""), true));
    else if (/^error(?:\[\w+\])?: /.test(line)) summary.push(summaryLine(line));
  }
  const failures: Failure[] = [];
  let cur: { f: Failure; lines: string[] } | null = null;
  const blocks: { f: Failure; lines: string[] }[] = [];
  for (const line of lines) {
    const header = /^---- (.+?) stdout ----$/.exec(line);
    if (header) {
      cur = { f: { file: null, name: header[1]!, loc: null, body: [] }, lines: [] };
      blocks.push(cur);
      failures.push(cur.f);
      continue;
    }
    if (/^failures:$|^test result: |^running \d+ tests?$/.test(line)) {
      cur = null;
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  for (const { f, lines: block } of blocks) {
    let panicked = false;
    let trace = false;
    for (const raw of block) {
      const line = raw.trimEnd();
      const t = line.trim();
      if (!t) continue;
      const panic = /^thread '.+?'(?: \(\d+\))? panicked at (?:'(.*)', )?(\S+?):(\d+):(\d+):?$/.exec(t);
      if (panic) {
        panicked = true;
        f.loc ??= `${panic[2]}:${panic[3]}:${panic[4]}`;
        if (panic[1]) f.body.push({ kind: "msg", text: panic[1] });
        continue;
      }
      if (/^note: run with `RUST_BACKTRACE/.test(t)) continue;
      if (/^stack backtrace:$/.test(t)) {
        trace = true;
        continue;
      }
      if (trace) {
        const at = /^at\s+(\S+?):(\d+):(\d+)$/.exec(t);
        if (at && !libraryPath(at[1]!)) f.loc = addFrame(f.body, `${at[1]}:${at[2]}:${at[3]}`, f.loc);
        continue;
      }
      f.body.push(panicked ? { kind: "msg", text: line } : { kind: "out", text: line });
    }
  }
  return { failures, summary, reported, counted: failures.length };
}

function parseGo(lines: string[]): Parsed | null {
  if (!lines.some((l) => /^\s*--- FAIL: \S/.test(l))) return null;
  const logs = new Map<string, string[]>();
  const failures: Failure[] = [];
  const raw = new Map<Failure, string[]>();
  const summary: SummaryLine[] = [];
  let running: string | null = null;
  let cur: Failure | null = null;
  for (const line of lines) {
    const run = /^=== (?:RUN|CONT|PAUSE|NAME)\s+(\S+)/.exec(line);
    if (run) {
      running = run[1]!;
      cur = null;
      continue;
    }
    const fail = /^\s*--- FAIL: (\S+) \([\d.]+m?s\)/.exec(line);
    if (fail) {
      cur = { file: null, name: fail[1]!, loc: null, body: [] };
      raw.set(cur, [...(logs.get(fail[1]!) ?? [])]);
      failures.push(cur);
      running = null;
      continue;
    }
    if (/^\s*--- (?:PASS|SKIP): /.test(line)) {
      cur = null;
      running = null;
      continue;
    }
    const pkg = /^(FAIL|ok)\s+(\S+)(?:\s+(?:[\d.]+m?s|\(cached\)|\[[^\]]+\]))?/.exec(line);
    if (pkg && /\t|\s{2,}|\[/.test(line)) {
      summary.push(summaryLine(line.replace(/\s+[\d.]+m?s\s*$/, ""), pkg[1] === "ok"));
      cur = null;
      running = null;
      continue;
    }
    if (/^(?:FAIL|PASS)$/.test(line.trim())) continue;
    if (/^exit status \d+$/.test(line)) {
      summary.push(summaryLine(line, true));
      continue;
    }
    if (cur) raw.get(cur)!.push(line);
    else if (running) {
      const list = logs.get(running) ?? [];
      list.push(line);
      logs.set(running, list);
    } else if (/^#\s\S+$/.test(line) || /^\S+\.go:\d+(?::\d+)?: /.test(line)) summary.push(summaryLine(line));
  }
  for (const f of failures) {
    for (const line of raw.get(f)!) {
      const t = line.trim();
      if (!t || /^goroutine \d+ \[/.test(t)) continue;
      const frame = /^(\/\S+\.go|\S+\.go):(\d+)(?: \+0x[0-9a-f]+)?$/.exec(t);
      if (frame) {
        if (!libraryPath(frame[1]!)) f.loc = addFrame(f.body, `${frame[1]}:${frame[2]}`, f.loc);
        continue;
      }
      if (/^(?:[\w.*/()-]+)\(.*\)$/.test(t) || /^created by /.test(t)) continue;
      f.body.push({ kind: "msg", text: t });
    }
    if (f.loc && f.body.some((e) => e.kind === "msg" && /^\S+\.go:\d+: /.test(e.text))) {
      f.body.unshift({ kind: "frame", text: f.loc });
      f.loc = null;
    }
  }
  return { failures, summary, reported: null, counted: failures.length };
}

const PYTEST_ENTRY_RE = /^(FAILED|ERROR) (\S+?\.py(?:::\S+)?)(?: - (.*))?$/;

function classifyPy(lines: string[], head: string | null): { body: Entry[]; loc: string | null } {
  const body: Entry[] = [];
  let loc: string | null = null;
  let captured = false;
  let source = -1;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (/^-{3,} Captured .+ -{3,}$/.test(t)) {
      captured = true;
      continue;
    }
    if (captured) {
      if (t) body.push({ kind: "out", text: line });
      continue;
    }
    if (/^E(?:\s|$)/.test(line)) {
      if (line.slice(1).trim()) body.push({ kind: "msg", text: line });
      continue;
    }
    const frame = /^(\S+?\.py):(\d+):(?: (.*))?$/.exec(line);
    if (frame) {
      if (!libraryPath(frame[1]!)) {
        const where = frame[3]?.startsWith("in ") ? ` ${frame[3]}` : "";
        loc = addFrame(body, `${frame[1]}:${frame[2]}${loc === null ? "" : where}`, loc);
      } else if (source >= 0) body.splice(source, 1);
      source = -1;
      continue;
    }
    if (/^>\s/.test(line)) {
      source = body.length;
      body.push({ kind: "source", text: t.replace(/^>\s*/, "") });
    }
  }
  const messages = body.filter((e) => e.kind === "msg");
  const width = Math.min(...messages.map((e) => e.text.slice(1).length - e.text.slice(1).trimStart().length));
  for (const e of messages) e.text = `E ${e.text.slice(1 + width)}`;
  if (head && !messages.some((e) => e.text.includes(head.replace(/\.\.\.$/, "")))) body.unshift({ kind: "msg", text: head });
  return { body, loc };
}

function pytestTotals(text: string, summary: SummaryLine[]): number {
  summary.push(summaryLine(text.replace(/ in [\d.]+s(?: \([\d:]+\))?$/, "")));
  return (countMatches([text], /(\d+) failed/) ?? 0) + (countMatches([text], /(\d+) errors?\b/) ?? 0);
}

function parsePytest(lines: string[]): Parsed | null {
  if (!lines.some((l) => /^={3,} (?:FAILURES|ERRORS|short test summary info) ={3,}$/.test(l) || PYTEST_ENTRY_RE.test(l))) return null;
  const blocks = new Map<string, string[]>();
  const entries: { kind: string; id: string; msg: string | null; inline: string[] }[] = [];
  const summary: SummaryLine[] = [];
  let section = "";
  let block: string[] | null = null;
  let last: { inline: string[] } | null = null;
  let reported: number | null = null;
  for (const line of lines) {
    const sec = /^={3,} (.+?) ={3,}$/.exec(line);
    if (sec) {
      section = sec[1]!;
      block = null;
      last = null;
      if (!/^(?:FAILURES|ERRORS|short test summary info|warnings summary|test session starts|PASSES)$/.test(section) &&
        /\b\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|deselected|warnings?)\b|no tests ran/.test(section)) {
        reported = pytestTotals(section, summary);
      }
      continue;
    }
    if (/^(?:\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|deselected|warnings?)(?:, |\s|$))+(?:in [\d.]+s(?: \([\d:]+\))?)?$/.test(line.trim())) {
      reported = pytestTotals(line.trim(), summary);
      continue;
    }
    if (/^!{3,} .+ !{3,}$/.test(line)) {
      summary.push(summaryLine(line.replace(/^!+ | !+$/g, "")));
      continue;
    }
    const header = /^_{3,} (.+?) _{3,}$/.exec(line);
    if (header && (section === "FAILURES" || section === "ERRORS")) {
      block = [];
      blocks.set(header[1]!, block);
      continue;
    }
    const entry = PYTEST_ENTRY_RE.exec(line);
    if (entry && section !== "FAILURES" && section !== "ERRORS") {
      block = null;
      const e = { kind: entry[1]!, id: entry[2]!, msg: entry[3] ?? null, inline: [] as string[] };
      entries.push(e);
      last = e;
      continue;
    }
    if (block) {
      block.push(line);
      continue;
    }
    if (last && /^E(?:\s|$)/.test(line)) last.inline.push(line);
    else if (last && line.trim()) last = null;
  }
  const used = new Set<string>();
  const failures: Failure[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const [file, ...parts] = e.id.split("::");
    const joined = parts.join(".");
    const key = [joined, `ERROR collecting ${e.id}`, `ERROR at setup of ${joined}`, `ERROR at teardown of ${joined}`]
      .find((k) => k && blocks.has(k) && !used.has(k));
    if (key) used.add(key);
    const { body, loc } = classifyPy(key ? blocks.get(key)! : e.inline, e.msg);
    const name = parts.length ? parts.join("::") : "(collection)";
    failures.push({ file: file!, name: e.kind === "ERROR" ? `${name} [error]` : name, loc, body, exact: true });
  }
  for (const [header, block] of blocks) {
    if (used.has(header)) continue;
    const { body, loc } = classifyPy(block, null);
    failures.push({ file: loc ? loc.replace(/:\d+$/, "") : null, name: header, loc, body, exact: true });
  }
  if (failures.length === 0) {
    for (const line of lines) {
      const progress = /^(\S+?)::(\S+) (FAILED|ERROR)\b/.exec(line);
      if (progress) failures.push({ file: progress[1]!, name: progress[3] === "ERROR" ? `${progress[2]} [error]` : progress[2]!, loc: null, body: [] });
    }
  }
  return { failures, summary, reported, counted: failures.length };
}

const SHORT_DIFF_LINES = 12;

const PARSERS = [parseCargo, parseGo, parsePytest, parseJest, parseVitest, parseMocha, parsePlaywright];

function diffIsRedundant(diff: Entry[], messages: string): boolean {
  if (diff.length === 0) return false;
  return diff.every((e) => {
    const t = e.text.trim();
    if (!/^[-+]/.test(t)) return false;
    const value = t.slice(1).trim().replace(/,$/, "");
    return value.length > 0 && messages.includes(value);
  });
}

function renderBody(f: Failure, full: boolean, level: Level): string[] {
  const lv = LIMITS[level];
  const messages = f.body.filter((e) => e.kind === "msg");
  if (!full) return [...f.body.filter((e) => e.kind === "source"), ...messages.slice(0, 1)].map((e) => `  ${e.text}`);
  const diff = f.body.filter((e) => e.kind === "diff");
  const dropDiff = lv.trimDiff && diffIsRedundant(diff, messages.map((e) => e.text).join("\n"));
  const used: Record<Kind, number> = { msg: 0, legend: 0, diff: 0, frame: 0, code: 0, source: 0, out: 0 };
  const skipped: Record<Kind, number> = { msg: 0, legend: 0, diff: 0, frame: 0, code: 0, source: 0, out: 0 };
  const cap: Record<Kind, number> = { msg: lv.msg, legend: Infinity, diff: lv.diff, frame: f.exact ? Infinity : lv.frames, code: 0, source: Infinity, out: lv.out };
  const changedOnly = lv.changedOnly && diff.length > SHORT_DIFF_LINES;
  const out: string[] = [];
  for (const e of f.body) {
    if ((e.kind === "diff" || e.kind === "legend") && dropDiff) continue;
    if (e.kind === "diff" && changedOnly && !/^[-+]/.test(e.text.trim())) {
      skipped.diff += 1;
      continue;
    }
    const kind = e.kind === "legend" ? "diff" : e.kind;
    if (used[kind] >= cap[kind] && e.kind !== "legend") {
      skipped[kind] += 1;
      continue;
    }
    if (e.kind !== "legend") used[kind] += 1;
    out.push(e.kind === "frame" ? `  at ${e.text}` : `  ${e.text}`);
  }
  const hidden = skipped.msg + skipped.diff + (level === "normal" ? skipped.frame + skipped.out : 0);
  if (hidden > 0) out.push(`  ${omissionMarker(hidden)}`);
  return out;
}

function joinNames(names: string[]): string {
  let prefix = names[0]!;
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.slice(0, Math.max(...["_", ":", ".", "/", " ", "›", "-", "[", "("].map((c) => prefix.lastIndexOf(c))) + 1);
  const rest = names.map((n) => n.slice(prefix.length));
  if (prefix.length >= 3 && rest.every((r) => r.length > 0 && !/[{},\s]/.test(r))) return `${prefix}{${rest.join(",")}}`;
  return names.join(", ");
}

function title(f: Failure): string {
  if (!f.loc) return `× ${f.name}`;
  const loc = !f.exact && f.file && f.loc.startsWith(`${f.file}:`) ? f.loc.slice(f.file.length) : f.loc;
  return `× ${f.name} ${loc}`;
}

function render(parsed: Parsed, level: Level): string {
  const lv = LIMITS[level];
  const seen = new Map<string, number>();
  const bulk = parsed.failures.length > lv.bulk;
  const items = parsed.failures.map((f) => {
    const head = f.body.find((e) => e.kind === "msg")?.text ?? "";
    const n = (seen.get(head) ?? 0) + 1;
    seen.set(head, n);
    const full = head === "" || !bulk || n <= lv.repeats;
    return { f, full, body: renderBody(f, full, level).join("\n") };
  });
  const out: string[] = [];
  let file: string | null | undefined;
  let printed: string | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.f.file !== file) {
      file = item.f.file;
      if (file) out.push(file);
    }
    let j = i;
    if (!item.full && item.f.loc === null) {
      while (j + 1 < items.length) {
        const next = items[j + 1]!;
        if (next.full || next.f.loc !== null || next.f.file !== item.f.file || next.body !== item.body) break;
        j += 1;
      }
    }
    out.push(j > i ? `× ${joinNames(items.slice(i, j + 1).map((x) => x.f.name))}` : title(item.f));
    i = j;
    const next = items[i + 1];
    if (next && next.f.file === item.f.file && next.body === item.body) continue;
    if (!item.body) continue;
    if (item.body === printed && level !== "normal") out.push("  ↑ same error");
    else {
      out.push(item.body);
      printed = item.body;
    }
  }
  for (const s of parsed.summary) if (!s.minor || level === "normal") out.push(s.text);
  return `${out.join("\n")}\n`;
}

export function summarizeTestFailures(output: string, verbosity: Level = "normal"): string | null {
  const lines = stripAnsi(output)
    .split("\n")
    .map((l) => {
      const line = l.endsWith("\r") ? l.slice(0, -1) : l;
      return line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line;
    });
  for (const parse of PARSERS) {
    const parsed = parse(lines);
    if (!parsed || parsed.failures.length === 0) continue;
    if (parsed.counted === 0 || (parsed.reported !== null && parsed.counted < parsed.reported)) return null;
    return render(parsed, verbosity);
  }
  return null;
}
