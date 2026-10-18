import { registerTransform } from "./registry";

export function squeezeOutput(lines: string[]): string[] {
  const out: string[] = [];
  let blankRun = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.replace(/\s+$/, "");
    if (line === "") {
      blankRun += 1;
      i += 1;
      if (blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;
    let run = 1;
    while (i + run < lines.length && lines[i + run]!.replace(/\s+$/, "") === line) run += 1;
    if (run >= 3) {
      out.push(line);
      out.push(`  … (repeated ${run}x)`);
    } else {
      for (let k = 0; k < run; k++) out.push(line);
    }
    i += run;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

registerTransform("squeeze-output", squeezeOutput);
