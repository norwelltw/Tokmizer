export function truncateLinesAt(lines: string[], width: number): string[] {
  return lines.map((line) => {
    if (line.length <= width) return line;
    const last = line.charCodeAt(width - 1);
    const next = line.charCodeAt(width);
    const cut = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? width - 1 : width;
    return `${line.slice(0, cut)}…`;
  });
}
