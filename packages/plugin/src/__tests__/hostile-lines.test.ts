import { describe, expect, it } from "vitest";
import { processOutput } from "../engine";
import { squeezeOutput } from "../engine/transforms/squeeze-output";
import { summarizeTestFailures } from "../engine/test-failures";

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = Date.now();
  const value = run();
  return { value, ms: Date.now() - started };
}

async function timedAsync<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await run();
  return { value, ms: Date.now() - started };
}

describe("lines built to slow the engine down", () => {
  it("squeezes a line of 200k spaces followed by a character in linear time", () => {
    const line = `${" ".repeat(200_000)}x`;
    const r = timed(() => squeezeOutput([line, line, line, "  tail  "]));
    expect(r.ms).toBeLessThan(200);
    expect(r.value).toEqual([line, "  … (repeated 3x)", "  tail"]);
  });

  it("compacts ruff output with a 200k-space line in linear time", async () => {
    const raw = `${" ".repeat(200_000)}x\n12 | code\n  |\nE501 line too long\n`;
    const r = await timedAsync(() => processOutput("ruff check .", raw, null, { exitCode: 1 }));
    expect(r.ms).toBeLessThan(1000);
    expect(r.value.output).toContain("E501 line too long");
    expect(r.value.output).not.toContain("12 | code");
  });

  it("reads a test failure log holding a 200k-character line in linear time", () => {
    const raw = `  1) ${"› ".repeat(100_000)}x\n  1 failed\n`;
    const r = timed(() => summarizeTestFailures(raw));
    expect(r.ms).toBeLessThan(500);
  });
});

describe("long logs cut in the middle", () => {
  const log = (error: string) => [...Array.from({ length: 1500 }, (_, i) => `INFO request ${i} ok`), error, ...Array.from({ length: 1500 }, (_, i) => `INFO request ${i + 1500} ok`)].join("\n") + "\n";

  for (const cmd of ["docker logs api", "kubectl logs pod-1", "cat app.log", "tail -n 3000 app.log", "make"]) {
    it(`keeps the error line of ${cmd}`, async () => {
      const r = await processOutput(cmd, log("ERROR: database connection refused at src/db.ts:77:12"), null, { exitCode: 0 });
      expect(r.output).toContain("ERROR: database connection refused at src/db.ts:77:12");
      expect(r.output.length).toBeLessThan(20_000);
    });
  }

  it("keeps at most twenty error lines from the cut part", async () => {
    const lines = [...Array.from({ length: 1000 }, (_, i) => `INFO ${i}`), ...Array.from({ length: 60 }, (_, i) => `ERROR boom ${i}`), ...Array.from({ length: 1000 }, (_, i) => `INFO ${i}`)];
    const r = await processOutput("docker logs api", lines.join("\n") + "\n", null, { exitCode: 0 });
    expect(r.output.match(/ERROR boom/g)?.length).toBe(20);
  });
});
