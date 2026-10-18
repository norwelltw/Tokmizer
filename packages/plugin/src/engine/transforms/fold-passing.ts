export const PASS_LINE = /^\s*(?:[✓✔√]|ok )/;
export const FAILURE = /✕|✗|×|\bFAIL\b|\bERROR\b|\bFATAL\b|\bError|\berror|Expected|Received|\bfailed\b|^\s*Tests?:|^\s*Test Suites?:/;

export function foldPassing(lines: string[], threshold: number): string[] {
  const min = threshold > 0 ? threshold : 5;
  const out: string[] = [];
  let run = 0;
  const flush = (buf: string[]) => {
    if (run >= min) out.push(`… ${run} passing checks folded …`);
    else out.push(...buf);
  };
  let buf: string[] = [];
  for (const ln of lines) {
    if (PASS_LINE.test(ln) && !FAILURE.test(ln)) {
      buf.push(ln);
      run += 1;
    } else {
      flush(buf);
      buf = [];
      run = 0;
      out.push(ln);
    }
  }
  flush(buf);
  return out;
}
