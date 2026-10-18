const ABS_PATH = /(?:\/[\w.@+-]+){3,}/g;

export function maskAbsPaths(lines: string[]): string[] {
  return lines.map((ln) =>
    ln.replace(ABS_PATH, (m) => {
      const parts = m.split("/").filter(Boolean);
      return parts.length <= 2 ? m : `…/${parts.slice(-2).join("/")}`;
    })
  );
}
