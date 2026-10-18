export function stripLinesMatching(lines: string[], patterns: RegExp[]): string[] {
  if (patterns.length === 0) return lines;
  return lines.filter((line) => !patterns.some((p) => p.test(line)));
}
