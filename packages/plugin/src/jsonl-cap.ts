import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export function capJsonl(file: string, triggerBytes: number, keepBytes: number): void {
  try {
    if (statSync(file).size <= triggerBytes) return;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    const kept: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      const n = Buffer.byteLength(line) + 1;
      if (size + n > keepBytes) break;
      kept.push(line);
      size += n;
    }
    kept.reverse();
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
    renameSync(tmp, file);
  } catch {}
}
