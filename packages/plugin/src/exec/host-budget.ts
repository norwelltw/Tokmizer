import { FAILURE } from "../engine/transforms/fold-passing";
import { omissionMarker } from "../engine/transforms/max-lines";

/** Claude Code shows about 2 KB of an output it persists to a file: Tokmizer stays within that. */
export const PREVIEW_BUDGET_CHARS = 2_500;
const DEFAULT_PERSIST_CHARS = 30_000;
// At most MAX_NOTABLE + 2 omission markers (~31 chars each) and the restore hint.
const MARKER_ROOM = 420;
const LAST_LINES = 8;
const FIRST_LINES = 3;
const MAX_NOTABLE = 10;
const MAX_LINE_CHARS = 300;
const WARNING = /\bWARN(?:ING)?\b/i;
const RESTORE_HINT_LINE = /^\[tkr restore [0-9a-f]+\]$/;

/** Text already shown, without its restore hints: the excerpt gets a single hint for the whole output. */
export function withoutRestoreHints(text: string): string {
  return text.split("\n").filter((line) => !RESTORE_HINT_LINE.test(line)).join("\n");
}

/** Size above which Claude Code persists a Bash output and shows only a preview. */
export function claudeCodePersistChars(env: NodeJS.ProcessEnv): number {
  const n = Number(env.BASH_MAX_OUTPUT_LENGTH);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PERSIST_CHARS;
}

/** Start and end of a too-long line, joined by an ellipsis, within `cap` characters. */
function clipLine(line: string, cap: number): string {
  const high = (i: number): boolean => line.charCodeAt(i) >= 0xd800 && line.charCodeAt(i) <= 0xdbff;
  const low = (i: number): boolean => line.charCodeAt(i) >= 0xdc00 && line.charCodeAt(i) <= 0xdfff;
  let head = Math.ceil((cap - 1) * 0.7);
  let tail = line.length - (cap - 1 - head);
  // Never cut between the two halves of a character outside the basic plane.
  if (high(head - 1) && low(head)) head -= 1;
  if (low(tail) && high(tail - 1)) tail += 1;
  return `${line.slice(0, head)}…${line.slice(tail)}`;
}

const OMISSION_MARKER_LINE = /^… \((\d+) more lines omitted\)$/;

/** Excerpt within the budget: the last lines (final summary), failure and warning lines, the first lines, then more of the end. */
export function previewExcerpt(text: string, budget: number = PREVIEW_BUDGET_CHARS): string {
  const raw = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const room = Math.max(0, budget - MARKER_ROOM);
  // Few lines share the budget (minified JSON, one-line logs): give each a bigger slice.
  const lineCap = Math.max(MAX_LINE_CHARS, Math.floor(room / Math.min(raw.length, LAST_LINES + FIRST_LINES)) - 1);
  const lines = raw.map((l) => (l.length > lineCap ? clipLine(l, lineCap) : l));
  const keep = new Set<number>();
  let used = 0;
  const take = (i: number): boolean => {
    if (keep.has(i)) return true;
    const cost = lines[i]!.length + 1;
    if (used + cost > room) return false;
    keep.add(i);
    used += cost;
    return true;
  };
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - LAST_LINES); i--) if (!take(i)) break;
  let notable = 0;
  for (let i = 0; i < lines.length && notable < MAX_NOTABLE; i++) {
    if (keep.has(i) || !(FAILURE.test(lines[i]!) || WARNING.test(lines[i]!))) continue;
    if (!take(i)) break;
    notable += 1;
  }
  for (let i = 0; i < Math.min(FIRST_LINES, lines.length); i++) if (!take(i)) break;
  for (let i = lines.length - 1 - LAST_LINES; i >= FIRST_LINES; i--) if (!take(i)) break;
  const out: string[] = [];
  let gap = 0;
  lines.forEach((line, i) => {
    if (!keep.has(i)) {
      // A dropped line that already stands for N omitted lines counts for N.
      gap += Number(OMISSION_MARKER_LINE.exec(line)?.[1] ?? 1);
      return;
    }
    if (gap > 0) out.push(omissionMarker(gap));
    gap = 0;
    out.push(line);
  });
  if (gap > 0) out.push(omissionMarker(gap));
  return `${out.join("\n")}\n`;
}
