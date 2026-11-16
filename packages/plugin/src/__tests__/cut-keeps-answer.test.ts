import { describe, expect, it } from "vitest";
import { processOutput } from "../engine";

// A cut that drops the line Claude needs costs a `tkr restore` turn, which
// re-sends the whole context: these outputs must keep their answer.

const ffmpegVerbose = [
  "Input #0, lavfi, from 'testsrc=duration=60:size=640x360:rate=30':",
  "  Stream #0:0: Video: wrapped_avframe, rgb24, 640x360, 30 fps",
  "Stream mapping:",
  "  Stream #0:0 -> #0:0 (wrapped_avframe (native) -> h264 (libx264))",
  ...Array.from({ length: 60 }, (_, i) => `[vf#0:0 @ 0x777b814000] filter step ${i} configured`),
  "[in#1/lavfi @ 0x777a808140] EOF while reading input",
  "[in#1/lavfi @ 0x777a808140] Terminating thread with return code 0 (success)",
  "[vf#0:0 @ 0x777b814000] All consumers returned EOF",
  "[vost#0:0/libx264 @ 0x777b81c000] [enc:libx264 @ 0x777b001650] Encoder thread received EOF",
  "[vost#0:0/libx264 @ 0x777b81c000] Terminating thread with return code 0 (success)",
  "[out#0/mp4 @ 0x777b004d80] All streams finished",
  "[out#0/mp4 @ 0x777b004d80] Terminating thread with return code 0 (success)",
  "[AVIOContext @ 0x777a808780] Statistics: 2040932 bytes written, 2 seeks, 11 writeouts",
  "[out#0/mp4 @ 0x777b004d80] Output file #0 (out.mp4):",
  "[out#0/mp4 @ 0x777b004d80]   Output stream #0:0 (video): 1800 frames encoded; 1800 packets muxed (1469216 bytes); ",
  "[out#0/mp4 @ 0x777b004d80]   Total: 1800 packets (1469216 bytes) muxed",
  "[out#0/mp4 @ 0x777b004d80] video:1435KiB audio:0KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: 2.625206%",
  "frame= 1800 fps=1058 q=-1.0 Lsize=    1993KiB time=00:01:00.00 bitrate= 272.1kbits/s speed=35.3x elapsed=0:00:01.70",
  "[aac @ 0x777a815c00] Qavg: 272.124",
  "[in#0/lavfi @ 0x777a808000] Input file #0 (testsrc=duration=60:size=640x360:rate=30):",
  "[in#0/lavfi @ 0x777a808000]   Input stream #0:0 (video): 1800 packets read (763200 bytes); 1800 frames decoded; 0 decode errors; ",
  "[in#0/lavfi @ 0x777a808000]   Total: 1800 packets (763200 bytes) demuxed",
  "",
  "Exiting with exit code 0"
].join("\n");

describe("cuts keep the answer", () => {
  it.each(["normal", "compact", "minimal"] as const)("ffmpeg keeps its final summary at %s verbosity", async (verbosity) => {
    const r = await processOutput("ffmpeg -loglevel verbose -i in.mp4 out.mp4", ffmpegVerbose, null, { exitCode: 0, verbosity });
    expect(r.filterId).toBe("ffmpeg");
    expect(r.output).toContain("1800 frames encoded");
    expect(r.output).toContain("video:1435KiB");
    expect(r.output).toContain("Lsize=    1993KiB");
    expect(r.output).not.toContain("Terminating thread");
    expect(r.output).not.toContain("Input file #0");
  });

  it("keeps a file read under 16 KB whole at compact verbosity, and still cuts it at minimal", async () => {
    const file = Array.from({ length: 300 }, (_, i) => `row ${i},value ${i * 7},label item-${i}`).join("\n") + "\n";
    expect(file.length).toBeLessThan(16_384);
    const compact = await processOutput("cat data.txt", file, null, { exitCode: 0, verbosity: "compact" });
    expect(compact.output).toBe(file);
    const minimal = await processOutput("cat data.txt", file, null, { exitCode: 0, verbosity: "minimal" });
    expect(minimal.output.length).toBeLessThan(file.length);
  });
});
