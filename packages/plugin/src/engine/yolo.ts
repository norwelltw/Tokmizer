const BYTE_LIMIT = 256;
const OMISSION = "\n[YOLO: omitted]\n";

export function yoloExcerpt(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= BYTE_LIMIT) return text;

  const contentBudget = BYTE_LIMIT - Buffer.byteLength(OMISSION, "utf8");
  let headEnd = Math.floor(contentBudget / 2);
  while ((bytes[headEnd]! & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = bytes.length - (contentBudget - headEnd);
  while ((bytes[tailStart]! & 0xc0) === 0x80) tailStart += 1;

  return bytes.subarray(0, headEnd).toString("utf8") + OMISSION + bytes.subarray(tailStart).toString("utf8");
}
