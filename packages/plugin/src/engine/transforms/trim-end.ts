import { registerTransform } from "./registry";

export function trimEnd(lines: string[]): string[] {
  return lines.map((l) => l.trimEnd());
}

registerTransform("trim-end", trimEnd);
