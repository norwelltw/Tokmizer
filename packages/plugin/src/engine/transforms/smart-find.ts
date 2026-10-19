import { registerTransform } from "./registry";

const MAX_OUTPUT_LINES = 1000;

function commonDir(dirs: string[]): string {
  let prefix = dirs[0]!.split("/");
  for (const d of dirs.slice(1)) {
    const segs = d.split("/");
    let i = 0;
    while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix.join("/");
}

function sharedExtension(names: string[]): string {
  if (names.length < 2 || names.some((n) => n.startsWith('"'))) return "";
  let suffix = names[0]!;
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < suffix.length && i < n.length && suffix[suffix.length - 1 - i] === n[n.length - 1 - i]) i += 1;
    suffix = suffix.slice(suffix.length - i);
    if (!suffix) return "";
  }
  const dot = suffix.indexOf(".");
  const ext = dot < 0 ? "" : suffix.slice(dot);
  return ext.length >= 3 && names.every((n) => n.length > ext.length) ? ext : "";
}

export function smartFind(lines: string[]): string[] {
  const cleaned = lines.filter((l) => l.trim() !== "");
  if (cleaned.length === 0) return lines;

  const pathLike = cleaned.filter((l) => !/\s/.test(l.trim())).length;
  if (pathLike < cleaned.length * 0.6) return lines;

  const filesByDir = new Map<string, string[]>();
  const errors: string[] = [];
  let fileCount = 0;
  for (const raw of cleaned) {
    const p = raw.trim();
    if (p.startsWith("find:")) {
      errors.push(p);
      continue;
    }
    const norm = p.replace(/^\.\//, "").replace(/\/+$/, "");
    const slash = norm.lastIndexOf("/");
    const dir = slash > 0 ? norm.slice(0, slash) : slash === 0 ? "/" : "";
    const base = slash >= 0 ? norm.slice(slash + 1) : norm;
    if (!base) continue;
    const arr = filesByDir.get(dir) ?? [];
    arr.push(/\s/.test(base) ? `"${base}"` : base);
    filesByDir.set(dir, arr);
    fileCount += 1;
  }
  if (fileCount === 0) return lines;

  const dirs = [...filesByDir.keys()].sort();
  const root = dirs.every((d) => d !== "") && !dirs.includes("/") ? commonDir(dirs) : "";

  const out: string[] = [`${fileCount}F ${dirs.length}D${root ? ` in ${root}/` : ""}:`];
  for (const d of dirs) {
    const rel = d === "/" ? "/" : root ? d.slice(root.length).replace(/^\//, "") : d;
    const files = filesByDir.get(d)!;
    const ext = sharedExtension(files);
    const names = ext ? files.map((f) => f.slice(0, -ext.length)) : files;
    out.push(`${rel === "/" ? "/" : rel ? `${rel}/` : "./"} (${files.length}${ext ? `, *${ext}` : ""}): ${names.join(" ")}`);
  }
  if (out.length + errors.length > MAX_OUTPUT_LINES) {
    const keep = Math.max(0, MAX_OUTPUT_LINES - errors.length);
    const omitted = out.length - keep;
    return [...out.slice(0, keep), `… ${omitted} more lines omitted`, ...errors];
  }
  return [...out, ...errors];
}

registerTransform("smart-find", smartFind);
