const GH_HEADER = /^ID {2,}TITLE {2,}BRANCH {2,}STATE {2,}CREATED *$/;
const OMISSION = /^… \([1-9]\d* more lines omitted\)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function compactJson(text: string, minimal: boolean): string {
  if (!minimal) return text.split("\n").map((line) => line.replace(/^[ \t]+|[ \t]+(?=\r?$)/g, "")).join("\n");
  let result = "";
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char !== " " && char !== "\t" && char !== "\r" && char !== "\n") {
      result += char;
    }
  }
  return result + (text.endsWith("\n") ? "\n" : "");
}

function compactGitHub(text: string, minimal: boolean): string {
  if (/@(?:p)?\d|\r/.test(text)) return text;
  const trailingNewline = text.endsWith("\n") ? "\n" : "";
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");
  const header = lines.findIndex((line) => GH_HEADER.test(line));
  if (header >= 0 && lines.slice(0, header).some((line) => line !== "" && !/^Showing \d+ of \d+ (?:open|closed|all) pull requests in \S+$/.test(line))) return text;
  const columnStarts = header >= 0 ? [...lines[header]!.matchAll(/\S+/g)].map((match) => match.index) : [];
  const rows: { index: number; cells: string[] }[] = [];
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (OMISSION.test(line)) continue;
    if (/…|\.\.\./.test(line)) return text;
    let cells: string[];
    if (header >= 0) {
      if (/[^\x20-\x7e]/.test(line)) return text;
      const slices = columnStarts.map((start, column) => line.slice(start, columnStarts[column + 1]));
      if (slices.slice(0, -1).some((cell) => cell[0] === " " || !cell.endsWith("  "))) return text;
      cells = slices.map((cell) => cell.replace(/ +$/, ""));
      if (!/^#\d+$/.test(cells[0]!) || !/^\S+$/.test(cells[2]!) || !/^(OPEN|CLOSED|MERGED|DRAFT)$/.test(cells[3]!) || !/^\d+(?:s|m|h|d|w|mo|y)$/.test(cells[4]!)) return text;
    } else {
      cells = line.split("\t");
      if (cells.length !== 5 || !/^\d+$/.test(cells[0]!) || !cells[1] || !cells[2] || !/^(OPEN|CLOSED|MERGED|DRAFT)$/.test(cells[3]!) || !ISO_DATE.test(cells[4]!) || !Number.isFinite(Date.parse(cells[4]!))) return text;
    }
    if (cells.some((cell) => /[\u0000-\u001f\u007f]/.test(cell))) return text;
    rows.push({ index, cells });
  }
  if (rows.length === 0) return text;
  if (header >= 0) lines[header] = "ID\tTITLE\tBRANCH\tSTATE\tCREATED";
  for (const row of rows) lines[row.index] = row.cells.join("\t");
  const compact = lines.join("\n") + trailingNewline;
  if (!minimal) return compact;
  const counts = new Map<string, number>();
  for (const { cells } of rows) counts.set(cells[1]!, (counts.get(cells[1]!) ?? 0) + 1);
  const references = new Map<string, string>();
  const definitions: string[] = [];
  for (const [title, count] of counts) {
    if (title.length < 40 || count < 3 || title.trim().split(/\s+/).length < 8) continue;
    const reference = `@${references.size + 1}`;
    const quoted = JSON.stringify(title).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    const definition = `TITLE ${reference} = ${quoted}`;
    if (count * (Buffer.byteLength(title) - Buffer.byteLength(reference)) <= Buffer.byteLength(definition) + 1) continue;
    references.set(title, reference);
    definitions.push(definition);
  }
  const prefixes = new Map<string, number>();
  for (const { cells } of rows) {
    if (references.has(cells[1]!)) continue;
    const prefix = /^((?:\S+\s+){4})\S/.exec(cells[1]!)?.[1];
    if (prefix && prefix.length >= 24) prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }
  const prefixReferences = new Map<string, string>();
  for (const [prefix, count] of prefixes) {
    if (count < 3) continue;
    const reference = `@p${prefixReferences.size + 1}`;
    const definition = `TITLE prefix ${reference} = ${JSON.stringify(prefix).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}`;
    if (count * (Buffer.byteLength(prefix) - Buffer.byteLength(reference) - 1) <= Buffer.byteLength(definition) + 1) continue;
    prefixReferences.set(prefix, reference);
    definitions.push(definition);
  }
  const suffix = rows[0]!.cells[4]!.slice(10);
  const sharedSuffix = rows.length >= 3 && ISO_DATE.test(rows[0]!.cells[4]!) &&
    rows.every(({ cells }) => ISO_DATE.test(cells[4]!) && cells[4]!.slice(10) === suffix) &&
    rows.length * suffix.length > `CREATED suffix = ${JSON.stringify(suffix)}`.length + 1;
  if (sharedSuffix) definitions.push(`CREATED suffix = ${JSON.stringify(suffix)}`);
  if (definitions.length === 0) return compact;
  for (const { index, cells } of rows) {
    const title = references.get(cells[1]!);
    const prefix = /^((?:\S+\s+){4})\S/.exec(cells[1]!)?.[1];
    const prefixReference = prefix ? prefixReferences.get(prefix) : undefined;
    lines[index] = cells.map((cell, column) => column === 1
      ? title ?? (prefixReference ? `${prefixReference}:${cell.slice(prefix!.length)}` : cell)
      : column === 4 && sharedSuffix ? cell.slice(0, 10) : cell).join("\t");
  }
  const candidate = [...lines, "", ...definitions].join("\n") + trailingNewline;
  return Buffer.byteLength(candidate) < Buffer.byteLength(compact) ? candidate : compact;
}

const GIT_SECTIONS: Record<string, "staged" | "unstaged" | "untracked"> = {
  "Changes to be committed:": "staged",
  "Changes not staged for commit:": "unstaged",
  "Untracked files:": "untracked"
};
const GIT_CHANGE_CODES: Record<string, string> = {
  modified: "M", deleted: "D", "new file": "A", renamed: "R", copied: "C", typechange: "T"
};
const GIT_ENTRY = /^\t(modified|deleted|new file|renamed|copied|typechange):\s+(.+)$/;
const GIT_BRANCH = /^On branch (\S+)$/;
const GIT_TRACKING = /^Your branch is (?:up to date with '([^']+)'|(ahead|behind)(?: of)? '([^']+)' by (\d+) commits?(?:, and can be fast-forwarded)?)\.$/;

function gitBranchHeader(lines: string[]): string[] {
  const branch = GIT_BRANCH.exec(lines[0] ?? "");
  if (!branch) return lines;
  const tracking = GIT_TRACKING.exec(lines[1] ?? "");
  if (!tracking) return [`* ${branch[1]}`, ...lines.slice(1)];
  const upstream = tracking[1] ?? tracking[3];
  const delta = tracking[2] ? ` [${tracking[2]} ${tracking[4]}]` : "";
  return [`* ${branch[1]}...${upstream}${delta}`, ...lines.slice(2)];
}

function compactGitStatus(text: string): string {
  const trailingNewline = text.endsWith("\n") ? "\n" : "";
  const lines = gitBranchHeader((trailingNewline ? text.slice(0, -1) : text).split("\n"));
  let section: "staged" | "unstaged" | "untracked" | null = null;
  const out: string[] = [];
  for (const line of lines) {
    if (Object.hasOwn(GIT_SECTIONS, line)) {
      section = GIT_SECTIONS[line]!;
      continue;
    }
    if (!line.startsWith("\t")) {
      section = null;
      out.push(line);
      continue;
    }
    if (section === "untracked") {
      out.push(`?? ${line.slice(1)}`);
      continue;
    }
    const entry = section ? GIT_ENTRY.exec(line) : null;
    if (!entry) return text;
    const code = GIT_CHANGE_CODES[entry[1]!]!;
    out.push(section === "staged" ? `${code}  ${entry[2]}` : ` ${code} ${entry[2]}`);
  }
  return out.join("\n") + trailingNewline;
}

const STAT_LINE = /^ (\S.*?) +\| +(\d+(?: [+-]+)?|Bin .*)$/;
const STAT_SUMMARY = /^ \d+ files? changed(?:, \d+ insertions?\(\+\))?(?:, \d+ deletions?\(-\))?$/;

function compactDiffStat(text: string): string {
  const lines = text.split("\n");
  for (let end = 0; end < lines.length; end += 1) {
    if (!STAT_SUMMARY.test(lines[end]!)) continue;
    let start = end;
    while (start > 0 && STAT_LINE.test(lines[start - 1]!)) start -= 1;
    for (let i = start; i < end; i += 1) lines[i] = lines[i]!.replace(STAT_LINE, " $1 | $2");
  }
  return lines.join("\n");
}

const PLAN_ATTRIBUTE_PADDING = /^( *(?:[~+-] +)?(?:[\w.-]+|"[^"\n]*")) {2,}= /gm;
const TABLE_HEADER = /^[A-Z][A-Z0-9_]*(?: +[A-Z][A-Z0-9_]*)+$/;
const OMISSION_LINE = /^… \(\d+ more lines omitted\)$/;

function tableCells(row: string, starts: number[]): string[] | null {
  const cells: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    if (start > 0 && row.length > start && row[start - 1] !== " ") return null;
    const cell = row.slice(start, starts[i + 1] ?? row.length).trim();
    if (cell.includes("\t")) return null;
    cells.push(cell);
  }
  return cells;
}

function compactAlignedTable(text: string): string {
  const trailingNewline = text.endsWith("\n") ? "\n" : "";
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");
  const notices: string[] = [];
  const rows: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("WARNING:")) rows.push(line);
    else if (!notices.includes(line)) notices.push(line);
  }
  const headerAt = rows.findIndex((l) => TABLE_HEADER.test(l));
  if (headerAt < 0) return [...notices, ...rows].join("\n") + trailingNewline;
  const header = rows[headerAt]!;
  const starts = [...header.matchAll(/\S+/g)].map((m) => m.index!);
  const out = [...notices, ...rows.slice(0, headerAt), header.split(/ +/).join("\t")];
  for (const row of rows.slice(headerAt + 1)) {
    if (OMISSION_LINE.test(row)) {
      out.push(row);
      continue;
    }
    const cells = row.startsWith(" ") || /[^\x20-\x7e]/.test(row) ? null : tableCells(row, starts);
    if (!cells) return [...notices, ...rows].join("\n") + trailingNewline;
    out.push(cells.join("\t"));
  }
  return out.join("\n") + trailingNewline;
}

function compactSpacedTable(text: string): string {
  const trailingNewline = text.endsWith("\n") ? "\n" : "";
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");
  const headerAt = lines.findIndex((l) => TABLE_HEADER.test(l.trimEnd()));
  if (headerAt < 0) return text;
  const columns = lines[headerAt]!.trim().split(/ {2,}/).length;
  if (columns < 2) return text;
  const out = [...lines.slice(0, headerAt), lines[headerAt]!.trim().split(/ {2,}/).join("\t")];
  for (const row of lines.slice(headerAt + 1)) {
    if (OMISSION_LINE.test(row)) {
      out.push(row);
      continue;
    }
    if (row.startsWith(" ") || row.includes("\t") || /[^\x20-\x7e]/.test(row)) return text;
    let cells = row.trimEnd().split(/ {2,}/);
    if (cells.length === columns - 1) {
      const gap = cells[0]!.indexOf(" ");
      if (gap < 0 || cells[0]!.indexOf(" ", gap + 1) >= 0) return text;
      cells = [cells[0]!.slice(0, gap), cells[0]!.slice(gap + 1), ...cells.slice(1)];
    }
    if (cells.length !== columns) return text;
    out.push(cells.join("\t"));
  }
  return out.join("\n") + trailingNewline;
}

export function compactStructuredOutput(
  text: string,
  verbosity: "normal" | "compact" | "minimal" | undefined,
  slug: string
): string {
  if (verbosity !== "compact" && verbosity !== "minimal") return text;
  let candidate = text;
  if (/^[ \t\r\n]*[\[{]/.test(text)) {
    try {
      JSON.parse(text);
    } catch {
      return text;
    }
    candidate = compactJson(text, verbosity === "minimal");
  } else if (slug === "gh") {
    candidate = compactGitHub(text, verbosity === "minimal");
  } else if (slug === "git-status") {
    candidate = compactGitStatus(text);
  } else if (slug === "gcloud") {
    candidate = compactAlignedTable(text);
  } else if (slug === "oc") {
    candidate = compactSpacedTable(text);
  } else if (slug === "git-diff") {
    candidate = compactDiffStat(text);
  } else if (slug === "tofu-plan") {
    candidate = text.replace(PLAN_ATTRIBUTE_PADDING, "$1 = ");
  }
  return Buffer.byteLength(candidate) < Buffer.byteLength(text) ? candidate : text;
}
