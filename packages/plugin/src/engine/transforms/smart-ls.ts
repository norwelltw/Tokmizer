import { registerTransform } from "./registry";

const MODE_RE = /^[dbclps\-][rwxsStT\-]{9}[@.+]?(?:\s|$)/;
const SECTION_HEADER_RE = /^[./~][^\s]*:$/;
const DATE_RE = String.raw`(?:[^\s\d]{3,}\s+\d{1,2}|\d{1,2}\s+[^\s\d]{3,})\s+(?:\d{1,2}:\d{2}|\d{4})|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s+[+-]\d{4})?`;
const ENTRY_RE = new RegExp(String.raw`^(\S+)\s+\d+\s+(\S+(?:\s+\S+)??)\s+(\d+(?:[.,]\d+)?[KMGTPkmgtp]?i?B?)\s+(?:${DATE_RE})\s+(.+)$`);
const UNIT_POWER: Record<string, number> = { k: 1, m: 2, g: 3, t: 4, p: 5 };
const MAX_OUTPUT_LINES = 1000;

type Entry = { name: string; size: string; sizeKey: number; isDir: boolean; mode: string; owner: string };

function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  const units = ["K", "M", "G", "T"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(1)}${units[u]}`;
}

function sizeKey(token: string): number {
  const m = /^(\d+(?:[.,]\d+)?)([KMGTPkmgtp])?/.exec(token)!;
  const unit = m[2] ? UNIT_POWER[m[2].toLowerCase()]! : 0;
  return Number(m[1]!.replace(",", ".")) * 1024 ** unit;
}

function parseEntry(line: string): Entry | null {
  const m = ENTRY_RE.exec(line);
  if (!m) return null;
  const name = m[4]!.trim();
  if (name === "" || name === "." || name === "..") return null;
  const raw = m[3]!;
  const size = /^\d+$/.test(raw) ? humanSize(Number(raw)) : raw;
  const isDir = line.charCodeAt(0) === 100;
  return { name, size, sizeKey: sizeKey(raw), isDir, mode: m[1]!, owner: m[2]!.replace(/\s+/g, " ") };
}

function dominantExt(files: Entry[]): string | null {
  if (files.length < 3) return null;
  const counts = new Map<string, number>();
  for (const f of files) {
    const dot = f.name.lastIndexOf(".");
    if (dot <= 0) continue;
    const ext = f.name.slice(dot);
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  let bestExt: string | null = null;
  let bestN = 0;
  for (const [ext, n] of counts) {
    if (n > bestN) {
      bestN = n;
      bestExt = ext;
    }
  }
  return bestExt && bestN >= Math.ceil(files.length / 2) ? `${bestN} ${bestExt}` : null;
}

const PLAIN_MIN_NAMES = 12;
const PLAIN_MIN_GROUP = 3;
const PLAIN_LINE_CHARS = 180;

function wrapped(head: string, words: string[]): string[] {
  const out: string[] = [];
  let line = head;
  for (const w of words) {
    if (line.length + 1 + w.length > PLAIN_LINE_CHARS && line !== head && line !== "  ") {
      out.push(line);
      line = "  ";
    }
    line += line === "  " ? w : ` ${w}`;
  }
  out.push(line);
  return out;
}

function extensionOf(name: string): string {
  const base = name.endsWith("/") ? "" : name;
  const first = base.indexOf(".", 1);
  return first > 0 ? base.slice(first) : "";
}

function plainLs(lines: string[]): string[] | null {
  const names = lines.filter((l) => l.trim() !== "");
  if (names.length < PLAIN_MIN_NAMES) return null;
  const first = lines.findIndex((l) => l.trim() !== "");
  const last = lines.length - 1 - [...lines].reverse().findIndex((l) => l.trim() !== "");
  if (lines.slice(first, last + 1).some((l) => l.trim() === "")) return null;
  if (names.some((n) => n.endsWith(":") || SECTION_HEADER_RE.test(n.trim()) || MODE_RE.test(n) || /^total\s+\d+/.test(n) || n !== n.trimEnd() || n.startsWith(" "))) return null;
  if (names.filter((n) => /\s/.test(n)).length > names.length * 0.2) return null;
  const quote = (n: string) => (/\s|"/.test(n) ? JSON.stringify(n) : n);
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const ext = extensionOf(n);
    const arr = groups.get(ext) ?? [];
    arr.push(n);
    groups.set(ext, arr);
  }
  const out: string[] = [`${names.length} entries:`];
  const rest: string[] = [];
  for (const [ext, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (ext && members.length >= PLAIN_MIN_GROUP && members.every((m) => !/\s|"/.test(m))) {
      out.push(...wrapped(`*${ext} (${members.length}):`, members.map((m) => m.slice(0, -ext.length))));
    } else {
      rest.push(...members);
    }
  }
  if (rest.length) out.push(...wrapped(`other (${rest.length}):`, rest.map(quote)));
  return out.join("\n").length < names.join("\n").length ? out : null;
}

/** True when the ls command line carries a flag that changes entry order (-t -S -U -f -r -v -X, --sort, --reverse). */
export function lsHasSortFlag(cmd: string | undefined): boolean {
  if (!cmd) return false;
  const m = /(?:^|[\s;&|(])ls(?=\s|$)([^|;&]*)/.exec(cmd);
  if (!m) return false;
  for (const tok of m[1]!.trim().split(/\s+/)) {
    if (tok === "--") break;
    if (/^--(?:sort|reverse|time)(?:=|$)/.test(tok)) return true;
    if (/^-[A-Za-z0-9]+$/.test(tok) && /[tSUfrvX]/.test(tok)) return true;
  }
  return false;
}

export function smartLs(lines: string[], cmd?: string): string[] {
  if (lsHasSortFlag(cmd)) return lines;
  const plain = plainLs(lines);
  if (plain) return plain;
  const dirs: Entry[] = [];
  const files: Entry[] = [];
  let parsedAny = false;

  for (const line of lines) {
    if (line.trim() === "" || /^total\s+\d+/.test(line)) continue;
    if (SECTION_HEADER_RE.test(line.trim())) return lines;
    if (!MODE_RE.test(line)) return lines;
    const e = parseEntry(line);
    if (!e) {
      if (/\s\.\.?$/.test(line)) continue;
      return lines;
    }
    parsedAny = true;
    (e.isDir ? dirs : files).push(e);
  }

  if (!parsedAny) return lines;

  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);
  dirs.sort(byName);
  files.sort((a, b) => b.sizeKey - a.sizeKey || byName(a, b));

  const shown = [...dirs, ...files];
  const owner = shown.every((e) => e.owner === shown[0]!.owner) ? shown[0]!.owner : null;

  let out: string[] = [];
  for (const e of shown) {
    const label = `${e.mode} ${owner === null ? `${e.owner} ` : ""}${e.isDir ? `${e.name}/` : e.name}`;
    out.push(e.isDir ? label : `${label}  ${e.size}`);
  }
  if (out.length > MAX_OUTPUT_LINES) {
    const omitted = out.length - MAX_OUTPUT_LINES;
    out = [...out.slice(0, MAX_OUTPUT_LINES), `… ${omitted} more lines omitted`];
  }

  const fileWord = files.length === 1 ? "file" : "files";
  const dirWord = dirs.length === 1 ? "dir" : "dirs";
  const dom = dominantExt(files);
  const summary =
    `${files.length} ${fileWord}, ${dirs.length} ${dirWord}` + (dom ? ` (${dom})` : "") + (owner === null ? "" : `, owner ${owner.replace(" ", ":")}`);
  out.push(summary);

  return out;
}

registerTransform("smart-ls", smartLs);
