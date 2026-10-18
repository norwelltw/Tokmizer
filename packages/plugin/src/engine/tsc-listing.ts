const FILE_LINE = /^(?:[A-Za-z]:)?[^\s"'<>|]+\.(?:[cm]?[jt]sx?|json)$/;
const LISTING_FLAG = /--(?:listFiles|listFilesOnly|listEmittedFiles|showConfig|explainFiles|traceResolution)(?:\s|=|$)/;

export function requestsTscListing(cmd: string): boolean {
  return LISTING_FLAG.test(cmd);
}

export function collapseTscFileList(text: string): string | null {
  const trailingNewline = text.endsWith("\n");
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");
  let count = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (!FILE_LINE.test(line)) return null;
    count += 1;
  }
  if (count < 2) return null;
  return `tsc: 0 errors, ${count} files${trailingNewline ? "\n" : ""}`;
}
