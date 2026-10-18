import { describe, expect, it } from "vitest";
import {
  condenseLogNoise,
  dropTimestampPrefix,
  dropVerboseLogs,
  dedupeAdjacent,
  collapseBlankRuns
} from "../engine/transforms/prompt-compress";

describe("dropTimestampPrefix", () => {
  it("strips ISO datetime", () => {
    const out = dropTimestampPrefix(["2025-01-01T12:34:56.789Z hello"]);
    expect(out[0]).toBe("hello");
  });

  it("strips HH:MM:SS", () => {
    const out = dropTimestampPrefix(["12:34:56 some event"]);
    expect(out[0]).toBe("some event");
  });

  it("strips HH:MM:SS.mmm", () => {
    const out = dropTimestampPrefix(["12:34:56.123 thing"]);
    expect(out[0]).toBe("thing");
  });

  it("leaves lines without timestamp", () => {
    expect(dropTimestampPrefix(["plain"])[0]).toBe("plain");
  });
});

describe("dropVerboseLogs", () => {
  it("removes DEBUG/TRACE/INFO/VERBOSE", () => {
    const lines = ["DEBUG x", "TRACE y", "INFO z", "VERBOSE q", "ERROR keep"];
    expect(dropVerboseLogs(lines)).toEqual(["… 4 verbose log lines dropped …", "ERROR keep"]);
  });

  it("keeps WARN/ERROR/FATAL", () => {
    expect(dropVerboseLogs(["WARN a", "ERROR b", "FATAL c"]).length).toBe(3);
  });

  it("keeps failures mentioning verbose levels", () => {
    const lines = [
      "ERROR: cannot parse INFO field",
      "WARN DEBUG flag ignored",
      "FATAL TRACE provider unavailable",
      "2025-01-01T12:34:56.789Z ERROR: invalid VERBOSE value",
      "12:34:56 WARN INFO field missing"
    ];
    expect(dropVerboseLogs(lines)).toEqual(lines);
  });

  it("keeps failures and warnings inside verbose logs", () => {
    const lines = [
      "INFO request failed: missing certificate",
      "[INFO] ERROR: failed to open",
      "DEBUG warning: skipped critical validation",
      "TRACE WARN: certificate expires today",
      "2025-01-01T12:34:56.789Z VERBOSE Warning: unsafe configuration"
    ];
    expect(dropVerboseLogs(lines)).toEqual(lines);
  });

  it("keeps failures regardless of diagnostic casing", () => {
    const lines = [
      "INFO deployment FAILED: missing required certificate",
      "INFO fatal: no signing material",
      "[DEBUG] request FaIlEd: connection refused",
      "2025-01-01T12:34:56.789Z TRACE error: invalid configuration"
    ];
    expect(dropVerboseLogs(lines)).toEqual(lines);
  });

  it("keeps code and data containing verbose levels", () => {
    const lines = [
      'const level = "INFO";',
      '  logger.log("DEBUG", message);',
      '{"level":"TRACE","message":"payload"}',
      "level: VERBOSE",
      'INFO("message");',
      "DEBUG.enabled = true;",
      "[INFO].length",
      "VERBOSE_MODE=true",
      "TRACE_ID=123"
    ];
    expect(dropVerboseLogs(lines)).toEqual(lines);
  });

  it("keeps declarations and assignments to verbose level identifiers", () => {
    const lines = [
      "const INFO = false;",
      "let DEBUG: boolean = false;",
      "INFO = false;",
      "TRACE += 1;",
      "DEBUG ||= false;"
    ];
    expect(dropVerboseLogs(lines)).toEqual(lines);
  });

  it("keeps bare level prefixes followed by an ambiguous colon", () => {
    const lines = [
      "INFO: boolean | undefined;",
      "DEBUG: string | undefined;",
      "TRACE: false | undefined;",
      "INFO : boolean",
      "INFO: detail"
    ];
    expect(dropVerboseLogs(lines)).toEqual(lines);
  });

  it("removes verbose levels at the start of a log line", () => {
    const lines = ["  DEBUG detail", "[TRACE] detail", "[INFO]: detail", "VERBOSE"];
    expect(dropVerboseLogs(lines)).toEqual(["… 4 verbose log lines dropped …"]);
  });

  it("removes timestamped verbose logs", () => {
    const lines = [
      "2025-01-01T12:34:56.789Z DEBUG detail",
      "2025-01-01 12:34:56 [TRACE] detail",
      "12:34:56 [INFO]: detail",
      "  12:34:56.123 VERBOSE detail"
    ];
    expect(dropVerboseLogs(lines)).toEqual(["… 4 verbose log lines dropped …"]);
  });
});

describe("dedupeAdjacent", () => {
  it("empty input", () => {
    expect(dedupeAdjacent([])).toEqual([]);
  });

  it("collapses run of duplicates", () => {
    expect(dedupeAdjacent(["a", "a", "a", "b"])).toEqual(["a ×3", "b"]);
  });

  it("non-adjacent stays separate", () => {
    expect(dedupeAdjacent(["a", "b", "a", "b"])).toEqual(["a", "b", "a", "b"]);
  });

  it("singleton not annotated", () => {
    expect(dedupeAdjacent(["x"])).toEqual(["x"]);
  });

  it("keeps a run of blank lines as one blank line, without a repeat count", () => {
    expect(dedupeAdjacent(["a", "", "", "b", "  ", "  ", "  "])).toEqual(["a", "", "b", "  "]);
  });
});

describe("collapseBlankRuns", () => {
  it("multiple blanks become single", () => {
    expect(collapseBlankRuns(["a", "", "", "", "b"])).toEqual(["a", "", "b"]);
  });

  it("no blanks unchanged", () => {
    expect(collapseBlankRuns(["a", "b"])).toEqual(["a", "b"]);
  });

  it("trailing blanks dropped", () => {
    expect(collapseBlankRuns(["a", "", ""])).toEqual(["a"]);
  });
});

describe("dropVerboseLogs honesty", () => {
  it("replaces dropped runs with an honest marker", () => {
    const lines = ["DEBUG a", "DEBUG b", "keep 1", "INFO c", "keep 2"];
    const out = dropVerboseLogs(lines);
    expect(out).toEqual([
      "… 2 verbose log lines dropped …",
      "keep 1",
      "… 1 verbose log line dropped …",
      "keep 2"
    ]);
  });

  it("leaves clean output untouched", () => {
    const lines = ["keep 1", "keep 2"];
    expect(dropVerboseLogs(lines)).toEqual(lines);
  });
});

describe("condenseLogNoise", () => {
  const info = (n: number) => Array.from({ length: n }, (_, i) => `2026-10-16 10:00:${String(i % 60).padStart(2, "0")} INFO worker: batch ${i}`);

  it("keeps the first and last lines of a long run of similar log lines", () => {
    const out = condenseLogNoise([...info(20), "KeyError: 'url'"]);
    expect(out).toEqual([info(20)[0], "… 17 similar log lines dropped …", info(20)[18], info(20)[19], "KeyError: 'url'"]);
  });

  it("leaves short runs, indented frames and failure lines alone", () => {
    const frames = Array.from({ length: 10 }, (_, i) => `  File "/app/m${i}.py", line ${i}, in f`);
    expect(condenseLogNoise([...info(7), ...frames])).toEqual([...info(7), ...frames]);
    const maven = ["[INFO] a SUCCESS", "[INFO] b SUCCESS", "[INFO] ---", "[INFO] BUILD FAILURE", "[INFO] ---", "[INFO] Total time: 3 s", "[INFO] Finished", "[INFO] ---", "[INFO] x", "[INFO] y"];
    expect(condenseLogNoise(maven)).toEqual(maven);
    const failures = Array.from({ length: 12 }, (_, i) => `test ${i} failed: expected ${i}`);
    expect(condenseLogNoise(failures)).toEqual(failures);
  });

  it("folds unlevelled lines that only differ by numbers", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `processed row ${i} of 12`);
    expect(condenseLogNoise(rows)).toEqual([rows[0], "… 9 similar log lines dropped …", rows[10], rows[11]]);
  });
});
