export function omissionMarker(omitted: number): string {
  return `… (${omitted} more lines omitted)`;
}

const ERROR_LINE = /\b(?:ERROR|FATAL|CRITICAL|PANIC)\b|\bpanic:|\bTraceback \(most recent|\b[A-Z][A-Za-z0-9]*(?:Error|Exception)\b|\berror(?:\[[A-Za-z0-9]+\])?:/;
const MAX_RESCUED_LINES = 20;
const MAX_RESCUED_LENGTH = 4_096;

export function headTailLines(lines: string[], cap: number): { kept: string[]; dropped: string[] } {
  if (lines.length <= cap) return { kept: lines, dropped: [] };
  const head = Math.ceil(cap * 0.7);
  const tail = cap - head;
  const dropped = lines.slice(head, lines.length - tail);
  const rescued = dropped.filter((line) => line.length <= MAX_RESCUED_LENGTH && ERROR_LINE.test(line)).slice(0, MAX_RESCUED_LINES);
  const omitted = dropped.length - rescued.length;
  return {
    kept: [...lines.slice(0, head), ...(omitted > 0 ? [omissionMarker(omitted)] : []), ...rescued, ...lines.slice(lines.length - tail)],
    dropped
  };
}
