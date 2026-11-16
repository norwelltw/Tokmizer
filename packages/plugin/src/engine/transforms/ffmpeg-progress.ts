import { registerTransform } from "./registry";

const PROGRESS_RE = /^(?:frame=\s*\d+\s|size=\s*\S+\s+time=|\[download\]\s+[\d.]+% of )/;

export function ffmpegProgress(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const parts = raw.includes("\r") ? raw.split("\r").filter((part) => part.trim() !== "") : [raw];
    for (const line of parts) {
      const previous = out[out.length - 1];
      if (previous !== undefined && PROGRESS_RE.test(line) && PROGRESS_RE.test(previous)) out[out.length - 1] = line;
      else out.push(line);
    }
  }
  return out;
}

registerTransform("ffmpeg-progress", ffmpegProgress);
