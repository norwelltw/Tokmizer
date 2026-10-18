import { registerTransform } from "./registry";

const RULE_LINE = /^[\s=]+$/;
const BANNER_AROUND_TEXT = /^\s*=+\s+(.*?)\s+=+\s*$/;
const MAX_BANNER_LEN = 512;

registerTransform("strip-banners", (lines) => {
  const out: string[] = [];
  for (const line of lines) {
    if (RULE_LINE.test(line)) continue;
    const banner = line.length <= MAX_BANNER_LEN ? BANNER_AROUND_TEXT.exec(line) : null;
    out.push(banner ? banner[1]! : line);
  }
  return out;
});
