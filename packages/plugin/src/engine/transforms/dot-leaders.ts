import { registerTransform } from "./registry";

const LEADER_RE = / \.{4,} /g;

export function dotLeaders(lines: string[]): string[] {
  return lines.map((l) => l.replace(LEADER_RE, " ").trimStart());
}

registerTransform("dot-leaders", dotLeaders);
