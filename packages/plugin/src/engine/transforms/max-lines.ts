export function omissionMarker(omitted: number): string {
  return `… (${omitted} more lines omitted)`;
}

export function headTailLines(lines: string[], cap: number): { kept: string[]; dropped: string[] } {
  if (lines.length <= cap) return { kept: lines, dropped: [] };
  const head = Math.ceil(cap * 0.7);
  const tail = cap - head;
  const dropped = lines.slice(head, lines.length - tail);
  return {
    kept: [...lines.slice(0, head), omissionMarker(dropped.length), ...lines.slice(lines.length - tail)],
    dropped
  };
}
