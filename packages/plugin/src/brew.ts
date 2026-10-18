import { readFileSync } from "node:fs";

const TAP_ROOTS = ["/opt/homebrew/Library/Taps", "/usr/local/Homebrew/Library/Taps", "/home/linuxbrew/.linuxbrew/Homebrew/Library/Taps"];
export const TAP_FORMULA_PATHS: readonly string[] = TAP_ROOTS.map((root) =>
  `${root}/norwelltw/homebrew-tokmizer/Formula/tokmizer.rb`
);

export function formulaWedged(content: string): boolean {
  return /^(?:<{7}|={7}|>{7})/m.test(content);
}

export function brewTapStatus(paths: readonly string[] = TAP_FORMULA_PATHS): { path: string; wedged: boolean } | null {
  for (const p of paths) {
    try {
      return { path: p, wedged: formulaWedged(readFileSync(p, "utf8")) };
    } catch {}
  }
  return null;
}
