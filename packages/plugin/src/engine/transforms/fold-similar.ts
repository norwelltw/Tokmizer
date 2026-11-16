import { FAILURE } from "./fold-passing";
import { ERROR_LINE } from "./max-lines";

const MIN_RUN = 4;
const NUMBER = /\d+(?:[.,]\d+)*/g;

// Folded runs never hold an error or a warning: saying so spares a `tkr restore` turn spent checking.
// content-cache recognizes this marker as a visible cut, so the restore hint stays.
// Only on long runs, where the doubt arises; short runs keep the shorter marker.
const NOTE_FROM = 20;

export function similarMarker(folded: number): string {
  return `… ${folded} similar log lines dropped${folded >= NOTE_FROM ? ", no errors" : ""} …`;
}

const WARNING = /\bWARN(?:ING)?\b/i;
const EXCEPTION = /Error|Exception|Traceback|panic|fail|FAIL|Fail|SEVERE|CRITICAL/;
const ANY_FAILURE = new RegExp(FAILURE.source, "i");
const WORD = /[A-Za-z]{2,}/;

// Anything that could be an error or a warning, in any case ("error while decoding", "✗ case 3").
function notable(line: string): boolean {
  return ERROR_LINE.test(line) || ANY_FAILURE.test(line) || WARNING.test(line) || EXCEPTION.test(line);
}

function shape(line: string): string {
  return line.replace(NUMBER, "#");
}

// Rows made only of numbers and punctuation are data (a table, a JSON array): never folded.
function foldable(line: string): boolean {
  return line.trim().length > 0 && WORD.test(shape(line)) && !notable(line);
}

/**
 * Folds runs of consecutive lines that differ only by their numbers (progress, step N/M, timings):
 * keeps the first and last line of each run around one marker. Error and warning lines are never folded.
 */
export function foldSimilarRuns(lines: string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let j = i + 1;
    if (foldable(line)) {
      const key = shape(line);
      while (j < lines.length && shape(lines[j]!) === key && foldable(lines[j]!)) j += 1;
    }
    const run = j - i;
    const marker = similarMarker(run - 2);
    // Only when the marker is shorter than what it replaces: a fold must save something.
    if (run >= MIN_RUN && lines.slice(i + 1, j - 1).reduce((n, l) => n + l.length + 1, 0) > marker.length + 1) {
      kept.push(line, marker, lines[j - 1]!);
      dropped.push(...lines.slice(i + 1, j - 1));
    } else {
      kept.push(...lines.slice(i, j));
    }
    i = j;
  }
  return { kept, dropped };
}
