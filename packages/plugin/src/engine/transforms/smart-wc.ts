import { registerTransform } from "./registry";

const WC_LINE_RE = /^\s*(\d+(?:\s+\d+){0,3})\s+(\S.*)$/;

export function smartWc(lines: string[]): string[] {
  const rows: { counts: string; path: string }[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = WC_LINE_RE.exec(line);
    if (!m) return lines;
    rows.push({ counts: m[1]!.replace(/\s+/g, " "), path: m[2]! });
  }
  const files = rows.filter((r) => r.path !== "total");
  if (files.length < 2) return rows.length ? rows.map((r) => `${r.counts} ${r.path}`) : lines;
  const dirs = files.map((r) => (r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/") + 1) : ""));
  let prefix = dirs[0]!;
  for (const d of dirs) while (prefix && !d.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1);
  const out = prefix ? [`in ${prefix}:`] : [];
  for (const r of rows) out.push(`${r.counts} ${r.path !== "total" && prefix ? r.path.slice(prefix.length) : r.path}`);
  return out;
}

registerTransform("smart-wc", smartWc);
