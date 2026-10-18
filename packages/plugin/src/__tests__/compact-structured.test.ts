import { describe, expect, it } from "vitest";
import { compactStructuredOutput } from "../engine/compact-structured";

const header = "ID    TITLE                                                                            BRANCH                 STATE       CREATED";
const title = "fix(parser): preserve repeated spaces, quoted values and every table cell";
const rows = [
  ["#12", title, "fix/parser", "OPEN", "2d"],
  ["#7", "Keep every field", "feature/all", "DRAFT", "3h"],
  ["#5", title, "release", "MERGED", "1w"],
  ["#33", title, "fix/second", "CLOSED", "4d"]
];

function paddedRow(cells: string[]): string {
  return cells.map((cell, index) => index < 4 ? cell.padEnd([6, 81, 23, 12][index]!) : cell).join("");
}

const table = [
  "Showing 4 of 12 open pull requests in owner/repo",
  "",
  header,
  ...rows.map(paddedRow),
  ""
].join("\n");

function decodeRows(text: string): string[][] {
  const titles = new Map<string, string>();
  const prefixes = new Map<string, string>();
  let createdSuffix = "";
  for (const line of text.split("\n")) {
    const definition = /^TITLE (@\d+) = (".*")$/.exec(line);
    if (definition) titles.set(definition[1]!, JSON.parse(definition[2]!));
    const prefix = /^TITLE prefix (@p\d+) = (".*")$/.exec(line);
    if (prefix) prefixes.set(prefix[1]!, JSON.parse(prefix[2]!));
    const suffix = /^CREATED suffix = (".*")$/.exec(line);
    if (suffix) createdSuffix = JSON.parse(suffix[1]!);
  }
  return text.split("\n").filter((line) => /^#?\d+\t/.test(line)).map((line) => {
    const cells = line.split("\t");
    cells[1] = titles.get(cells[1]!) ?? cells[1]!;
    const prefix = /^(@p\d+):(.*)$/.exec(cells[1]!);
    if (prefix) cells[1] = prefixes.get(prefix[1]!)! + prefix[2];
    if (createdSuffix) cells[4] += createdSuffix;
    return cells;
  });
}

describe("structured JSON compaction", () => {
  const source = '{\n    "large": 9007199254740993,\n    "huge": 1e400,\n    "zero": -0,\n    "same": 1,\n    "same": 2,\n    "text": "  space  \\\" \\\\ \\n é 🐈  "  \n}\n';
  const compact = '{\n"large": 9007199254740993,\n"huge": 1e400,\n"zero": -0,\n"same": 1,\n"same": 2,\n"text": "  space  \\\" \\\\ \\n é 🐈  "\n}\n';
  const minimal = '{"large":9007199254740993,"huge":1e400,"zero":-0,"same":1,"same":2,"text":"  space  \\\" \\\\ \\n é 🐈  "}\n';

  it("removes indentation without rewriting numeric lexemes, duplicate keys or string values", () => {
    expect(compactStructuredOutput(source, "compact", "aws")).toBe(compact);
    expect(compactStructuredOutput(source, "minimal", "aws")).toBe(minimal);
  });

  it("preserves literal Unicode line separators and whitespace inside strings", () => {
    const input = '{\n  "text": "before\u2028  after\u2029  end",\n  "list": [ 1, 2 ]\n}';
    expect(compactStructuredOutput(input, "compact", "gh-api")).toBe('{\n"text": "before\u2028  after\u2029  end",\n"list": [ 1, 2 ]\n}');
    expect(compactStructuredOutput(input, "minimal", "gh-api")).toBe('{"text":"before\u2028  after\u2029  end","list":[1,2]}');
  });

  it("handles arrays, CRLF and escaped backslashes before quotes", () => {
    const input = '[\r\n\t"c:\\\\", \r\n\t{ "escaped": "quote: \\\"" }\r\n]\r\n';
    const output = compactStructuredOutput(input, "minimal", "aws");
    expect(output).toBe('["c:\\\\",{"escaped":"quote: \\\""}]\n');
    expect(JSON.parse(output)).toEqual(JSON.parse(input));
  });

  it.each([
    '{\n  "a": 1,\n… (30 more lines omitted)\n}',
    '{\n  "a": "unfinished',
    '{ "a": 1 }\nwarning: more output',
    '{ "a": 1, }',
    ' [1, 2',
    ' "  literal  " ',
    ' 9007199254740993 ',
    '{"already":"compact"}'
  ])("keeps invalid, incomplete, scalar or already compact JSON unchanged: %s", (input) => {
    expect(compactStructuredOutput(input, "minimal", "aws")).toBe(input);
  });

  it.each(["normal", undefined] as const)("leaves structured data unchanged at %s verbosity", (verbosity) => {
    expect(compactStructuredOutput(source, verbosity, "aws")).toBe(source);
    expect(compactStructuredOutput(table, verbosity, "gh")).toBe(table);
  });
});

describe("GitHub table compaction", () => {
  it("factors common title prefixes and timestamp suffixes while preserving every cell", () => {
    const values = Array.from({ length: 20 }, (_, i) => [String(100 + i), `Repair invoice validation case ${i} — keep \"quoted\" details`, `fix/invoice-${i}`, i === 0 ? "DRAFT" : "OPEN", `2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z`]);
    const input = values.map(row => row.join("\t")).join("\n") + "\n";
    const output = compactStructuredOutput(input, "minimal", "gh");
    expect(decodeRows(output)).toEqual(values);
    expect(Buffer.byteLength(output)).toBeLessThan(Buffer.byteLength(input) * 0.8);
    expect(compactStructuredOutput(input, "normal", "gh")).toBe(input);
    expect(compactStructuredOutput(input, "compact", "gh")).toBe(input);
  });
  it("keeps all cells and their order while removing alignment padding", () => {
    const output = compactStructuredOutput(table, "compact", "gh");
    expect(output).toContain("ID\tTITLE\tBRANCH\tSTATE\tCREATED\n");
    expect(output.startsWith("Showing 4 of 12 open pull requests in owner/repo\n\n")).toBe(true);
    expect(decodeRows(output)).toEqual(rows);
    expect(output.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(output)).toBeLessThan(Buffer.byteLength(table));
  });

  it("keeps distinct timestamp suffixes and avoids prefix reference collisions", () => {
    const values = Array.from({ length: 6 }, (_, i) => [String(i + 1), `Repair invoice validation case ${i}`, `fix/${i}`, "OPEN", `2026-10-01T12:00:0${i}Z`]);
    const input = values.map(row => row.join("\t")).join("\n");
    const output = compactStructuredOutput(input, "minimal", "gh");
    expect(decodeRows(output)).toEqual(values);
    expect(output).not.toContain("CREATED suffix");
    const colliding = input.replace("case 0", "case @p1:0");
    expect(compactStructuredOutput(colliding, "minimal", "gh")).toBe(colliding);
  });

  it("factors repeated long titles without losing their strings or row order", () => {
    const compact = compactStructuredOutput(table, "compact", "gh");
    const minimal = compactStructuredOutput(table, "minimal", "gh");
    expect(minimal).toContain(`TITLE @1 = ${JSON.stringify(title)}`);
    expect(decodeRows(minimal)).toEqual(rows);
    expect(Buffer.byteLength(minimal)).toBeLessThan(Buffer.byteLength(compact));
  });

  it("keeps the omission marker between the same surrounding rows", () => {
    const input = table.replace(paddedRow(rows[1]!), "… (17 more lines omitted)");
    const output = compactStructuredOutput(input, "minimal", "gh");
    expect(output).toContain("#12\t@1\tfix/parser\tOPEN\t2d\n… (17 more lines omitted)\n#5\t@1\trelease\tMERGED\t1w");
    expect(decodeRows(output)).toEqual([rows[0], rows[2], rows[3]]);
  });

  it("does not add title definitions when the extra representation is larger", () => {
    const input = `${header}\n${paddedRow(["#1", "Small title", "a", "OPEN", "1d"])}\n${paddedRow(["#2", "Small title", "b", "CLOSED", "2d"])}`;
    const output = compactStructuredOutput(input, "minimal", "gh");
    expect(output).toBe("ID\tTITLE\tBRANCH\tSTATE\tCREATED\n#1\tSmall title\ta\tOPEN\t1d\n#2\tSmall title\tb\tCLOSED\t2d");
  });

  it.each([
    `${header}\n#1    Preserve  intentional double spacing    fix/test    OPEN    1d`,
    table.replace(title, "a title with @1 inside"),
    table.replace(title, 'TITLE @1 = "existing definition"'),
    table.replace(title, "A title already cut…"),
    table.replace(title, "A title already cut..."),
    table.replace(paddedRow(rows[0]!), paddedRow(["#12", "Preserve important  release", "", "OPEN", "2d"])),
    table.replace("fix/parser", "fix/part\tmore"),
    table.replace("OPEN        2d", "OPEN"),
    `${table}${header}\n#8    Other table    other    OPEN    1d`,
    `${table}unexpected diagnostic\n`,
    `${header}\n#1    Ambiguous    title    branch    OPEN    1d    extra`,
    `${header}\n#1    A title    branch    OPEN    yesterday`,
    "NAME    STATE\nvalue    OPEN\n"
  ])("leaves ambiguous, colliding, multiple or truncated tables unchanged", (input) => {
    expect(compactStructuredOutput(input, "compact", "gh")).toBe(input);
    expect(compactStructuredOutput(input, "minimal", "gh")).toBe(input);
  });

  it("preserves internal title spacing when header column boundaries are proven", () => {
    const cells = ["#1", "Preserve important  release details", "fix/parser", "OPEN", "1d"];
    const input = `${header}\n${paddedRow(cells)}\n`;
    expect(decodeRows(compactStructuredOutput(input, "compact", "gh"))).toEqual([cells]);
  });

  it("does not infer a branch from title words when the aligned branch column is empty", () => {
    const input = "ID    TITLE                                                                            BRANCH                 STATE       CREATED\n#1    Preserve important  release                                                                             OPEN        1d";
    expect(compactStructuredOutput(input, "compact", "gh")).toBe(input);
    expect(compactStructuredOutput(input, "minimal", "gh")).toBe(input);
  });

  it("leaves TTY text with uncertain display widths unchanged", () => {
    const input = `${header}\n${paddedRow(["#1", "Preserve 界 and combining e\u0301 without shifting columns", "fix/parser", "OPEN", "1d"])}\n`;
    expect(compactStructuredOutput(input, "compact", "gh")).toBe(input);
  });

  it("rejects long table cells whose trailing padding contains a non-space suffix", () => {
    const wideHeader = `ID    TITLE${" ".repeat(8000)}BRANCH    STATE    CREATED`;
    const input = `${wideHeader}\n#1    x${" ".repeat(8003)}xmain      OPEN     1d\n`;
    expect(compactStructuredOutput(input, "compact", "gh")).toBe(input);
    expect(compactStructuredOutput(input, "minimal", "gh")).toBe(input);
  });

  it("does not reinterpret another command's matching text as a GitHub table", () => {
    expect(compactStructuredOutput(table, "minimal", "kubectl")).toBe(table);
    expect(compactStructuredOutput(table, "compact", "read-tool")).toBe(table);
  });

  it("factors native TSV titles while preserving all five cells without adding a header", () => {
    const nativeTitle = 'fix(parser): preserve  "quoted" strings, \\ backslashes and données Unicode';
    const nativeRows = [
      ["101", nativeTitle, "fix/parser", "OPEN", "2026-10-01T12:00:00Z"],
      ["102", nativeTitle, "release", "MERGED", "2026-10-02T12:00:00Z"],
      ["103", nativeTitle, "fix/é", "DRAFT", "2026-10-03T12:00:00Z"]
    ];
    const input = nativeRows.map((row) => row.join("\t")).join("\n") + "\n";
    expect(compactStructuredOutput(input, "compact", "gh")).toBe(input);
    const output = compactStructuredOutput(input, "minimal", "gh");
    expect(output.startsWith("101\t@1\t")).toBe(true);
    expect(output).not.toContain("ID\tTITLE");
    expect(decodeRows(output)).toEqual(nativeRows);
    expect(Buffer.byteLength(output)).toBeLessThan(Buffer.byteLength(input));
  });

  it.each([
    ["a".repeat(48), 2],
    ["test ".repeat(10).trimEnd(), 2],
    ["a".repeat(48), 3],
    [title, 2]
  ] as const)("keeps low-diversity or twice-repeated native titles inline", (nativeTitle, count) => {
    const input = Array.from({ length: count }, (_, index) => `${index + 1}\t${nativeTitle}\tfix/parser\tOPEN\t2026-10-01T12:00:00Z`).join("\n") + "\n";
    expect(compactStructuredOutput(input, "minimal", "gh")).toBe(input);
  });

  it.each([
    `1\t${title}\tbranch\tOPEN\t2026-10-01T12:00:00Z\textra`,
    `1\t${title}\t\tOPEN\t2026-10-01T12:00:00Z`,
    `1\t${title}\tbranch\tUNKNOWN\t2026-10-01T12:00:00Z`,
    `1\t${title}\tbranch\tOPEN\tyesterday`,
    `1\t${title}\tbranch\tOPEN\t2026-99-01T12:00:00Z`,
    `1\t${title}\tbranch\tOPEN\t2026-10-01T12:00:00Z\n\n2\t${title}\tbranch\tOPEN\t2026-10-01T12:00:00Z`,
    `1\t${title}\tbranch\tOPEN\t2026-10-01T12:00:00Z\nID\tTITLE\tBRANCH\tSTATE\tCREATED`
  ])("preserves malformed or multiple native TSV tables", (input) => {
    expect(compactStructuredOutput(input, "minimal", "gh")).toBe(input);
  });
});
