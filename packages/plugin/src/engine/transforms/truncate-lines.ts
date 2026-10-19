// Kept whole only while small: a large minified document is still cut.
const JSON_KEEP_MAX = 4096;

function isJsonValue(text: string): boolean {
  const t = text.trim();
  if (t.length > JSON_KEEP_MAX) return false;
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

export function truncateLinesAt(lines: string[], width: number): string[] {
  if (lines.some((l) => l.length > width) && isJsonValue(lines.join("\n"))) return lines;
  return lines.map((line) => {
    if (line.length <= width) return line;
    if (isJsonValue(line)) return line;
    const last = line.charCodeAt(width - 1);
    const next = line.charCodeAt(width);
    const cut = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? width - 1 : width;
    return `${line.slice(0, cut)}…`;
  });
}
