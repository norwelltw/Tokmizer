import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { processOutput, setFilterResolver } from "../engine";
import { FilterDef } from "../engine/schema";
import { ffmpegProgress } from "../engine/transforms/ffmpeg-progress";

const source = parseToml(readFileSync(fileURLToPath(new URL("../../filters/video.toml", import.meta.url)), "utf8")) as {
  filters: Record<string, Record<string, unknown>>;
};
const filters = Object.entries(source.filters).map(([slug, body]) => {
  const def = FilterDef.parse({ slug, ...body });
  return { ...def, matchRegex: new RegExp(def.match_command) };
});
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/video/${name}`, import.meta.url)), "utf8");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const matches = (slug: string, cmd: string) => filters.find((f) => f.slug === slug)!.matchRegex.test(cmd);

beforeEach(() => {
  setFilterResolver(async (cmd) => filters.find((f) => f.matchRegex.test(cmd)) ?? null);
});

afterEach(() => {
  setFilterResolver(null);
});

describe("hyperframes render filter", () => {
  it("keeps warnings and the final summary, drops progress and internal logs", async () => {
    const raw = fixture("hyperframes-render.txt");
    const r = await processOutput("npx hyperframes render --fps 30 --quality delivery -o renders/demo.mp4", raw, null, { exitCode: 0 });
    expect(r.filterId).toBe("hyperframes-render");
    expect(r.output).toContain("rendered in 23.1s");
    expect(r.output).toContain("capture 9.6s · encode 11.0s");
    expect(r.output).toContain("/work/demo/renders/demo.mp4");
    expect(r.output).toContain('[WARN] [compile] Audio "voice"');
    expect(r.output).not.toContain("@hf-progress");
    expect(r.output).not.toContain("[INFO]");
    expect(r.output).not.toContain("[initSession:");
    expect(r.output).not.toContain("█");
    expect(r.output).not.toContain("Framey");
    expect(bytes(r.output)).toBeLessThan(bytes(raw) * 0.1);
  });

  it("matches render invocations only and leaves JSON output alone", () => {
    for (const cmd of [
      "hyperframes render --quality draft",
      "npx hyperframes render",
      "npx --yes hyperframes@0.8.174 render -o out.mp4",
      "npx -y hyperframes render --gpu"
    ]) expect(matches("hyperframes-render", cmd), cmd).toBe(true);
    for (const cmd of [
      "hyperframes render --batch rows.json --json",
      "hyperframes check --json",
      "hyperframes docs render",
      "hyperframes timeline --json"
    ]) expect(matches("hyperframes-render", cmd), cmd).toBe(false);
  });
});

describe("hyperframes check, lint and snapshot filter", () => {
  it("drops check progress and keeps every section and finding of a passing check", async () => {
    const raw = fixture("hyperframes-check.txt");
    const r = await processOutput("npx hyperframes check", raw, null, { exitCode: 0 });
    expect(r.filterId).toBe("hyperframes-check");
    expect(r.output).toContain("Check passed");
    expect(r.output).toContain("sweep_static");
    expect(r.output).toContain("audio_none");
    expect(r.output).toContain("Report: /work/demo/.hyperframes/artifacts/checks/");
    for (const section of ["Lint", "Runtime", "Layout", "Motion", "Contrast", "Craft", "Audio", "Snapshots"]) {
      expect(r.output).toMatch(new RegExp(`^${section}$`, "m"));
    }
    expect(r.output).not.toContain("[hyperframes] check:");
    expect(r.output).not.toContain("browserGpuMode");
    expect(bytes(r.output)).toBeLessThan(bytes(raw) * 0.4);
  });

  it("keeps every finding and fix of a failing check", async () => {
    const r = await processOutput("npx hyperframes check", fixture("hyperframes-check-fail.txt"), null, { exitCode: 1 });
    expect(r.output).toContain("✗ video_missing_muted");
    expect(r.output).toContain("⚠ clip_ends_past_root_duration");
    expect(r.output).toContain("✗ missing_local_asset");
    expect(r.output).toContain('Fix: Add "assets/missing.mp4" to the project directory');
    expect(r.output).toContain("/work/bad/index.html #v1 t=0s");
    expect(r.output).toContain("2 error(s), 1 warning(s), 0 info(s)");
    expect(r.output).toContain("Browser session never ran");
    expect(r.output).toContain("Check failed");
  });

  it("keeps every finding of a failing lint", async () => {
    const r = await processOutput("hyperframes lint", fixture("hyperframes-lint-fail.txt"), null, { exitCode: 1 });
    expect(r.output).toContain("/work/bad/index.html:54:7] video_missing_muted [v1]");
    expect(r.output).toContain("clip_ends_past_root_duration [sub]");
    expect(r.output).toContain("Fix: Extend the root data-duration to 22");
    expect(r.output).toContain("2 error(s), 1 warning(s)");
  });

  it("keeps every snapshot path and drops capture progress", async () => {
    const raw = fixture("hyperframes-snapshot.txt");
    const r = await processOutput("npx hyperframes snapshot --at 0.5,1", raw, null, { exitCode: 0 });
    expect(r.filterId).toBe("hyperframes-check");
    expect(r.output).toContain("3 snapshots saved to /work/demo/.hyperframes/artifacts/snapshots/");
    for (const name of ["frame-00-at-0.5s.png", "frame-01-at-1s.png", "frame-02-at-9.75s.png", "contact-sheet.jpg"]) {
      expect(r.output).toContain(name);
    }
    expect(r.output).toContain("added an end-of-timeline frame at 9.75s");
    expect(r.output).not.toContain("[hyperframes] snapshot: frame");
    expect(r.output).not.toContain("browserGpuMode");
    expect(bytes(r.output)).toBeLessThan(bytes(raw));
  });

  it("matches check, lint and snapshot only and leaves JSON output alone", () => {
    for (const cmd of ["hyperframes check", "npx hyperframes lint", "npx --yes hyperframes@0.8.174 snapshot --at 1,2"]) {
      expect(matches("hyperframes-check", cmd), cmd).toBe(true);
    }
    for (const cmd of ["hyperframes check --json", "hyperframes render", "hyperframes timeline --json", "hyperframes docs check"]) {
      expect(matches("hyperframes-check", cmd), cmd).toBe(false);
    }
  });
});

describe("ffmpeg filter", () => {
  it("keeps inputs, stream mapping, output and the final progress line of an encode", async () => {
    const raw = fixture("ffmpeg-encode.txt");
    const r = await processOutput("ffmpeg -nostdin -y -f lavfi -i testsrc -c:v libx264 clip.mp4", raw, null, { exitCode: 0 });
    expect(r.filterId).toBe("ffmpeg");
    expect(r.output).toContain("Stream #0:0 -> #0:0 (wrapped_avframe (native) -> h264 (libx264))");
    expect(r.output).toContain("Output #0, mp4, to 'clip.mp4':");
    expect(r.output).toContain("1080x1920");
    expect(r.output).toMatch(/^frame=\s+120 .*speed=/m);
    expect(r.output).toMatch(/^\[out#0\/mp4 @ [^\]]+\] video:/m);
    expect(r.output).not.toContain("ffmpeg version");
    expect(r.output).not.toContain("configuration:");
    expect(r.output).not.toContain("libavcodec");
    expect(r.output).not.toMatch(/\[libx264 @ [^\]]+\] frame I:/);
    expect(bytes(r.output)).toBeLessThan(bytes(raw) * 0.5);
  });

  it("keeps the proof that a cut was a stream copy", async () => {
    const r = await processOutput("ffmpeg -nostdin -y -i clip.mp4 -ss 1 -t 2 -c copy coupe.mp4", fixture("ffmpeg-copy.txt"), null, { exitCode: 0 });
    expect(r.output).toContain("Stream #0:0 -> #0:0 (copy)");
    expect(r.output).toContain("Stream #0:1 -> #0:1 (copy)");
    expect(r.output).not.toContain("ffmpeg version");
  });

  it("keeps the error and drops the banner when ffmpeg fails", async () => {
    const r = await processOutput("ffmpeg -nostdin -y -i absent.mp4 -c copy rien.mp4", fixture("ffmpeg-fail.txt"), null, { exitCode: 254 });
    expect(r.output).toContain("No such file or directory");
    expect(r.output).toContain("absent.mp4");
    expect(r.output).not.toContain("configuration:");
  });

  it("collapses repeated progress to its last state", () => {
    const redrawn = "frame=   10 fps=0.0 q=28.0 size=       0KiB time=00:00:00.33 bitrate=   1.1kbits/s speed=0.6x\rframe=   60 fps= 58 q=28.0 size=     256KiB time=00:00:02.00 bitrate=1048.6kbits/s speed=1.9x\rframe=  120 fps= 60 q=-1.0 Lsize=     512KiB time=00:00:03.93 bitrate=1066.0kbits/s speed=1.96x\r";
    expect(ffmpegProgress(["Stream mapping:", redrawn, "[out#0/mp4 @ 0x1] video:500KiB"])).toEqual([
      "Stream mapping:",
      "frame=  120 fps= 60 q=-1.0 Lsize=     512KiB time=00:00:03.93 bitrate=1066.0kbits/s speed=1.96x",
      "[out#0/mp4 @ 0x1] video:500KiB"
    ]);
    expect(ffmpegProgress([
      "size=     128KiB time=00:00:08.00 bitrate= 131.1kbits/s speed= 512x",
      "size=     256KiB time=00:00:16.00 bitrate= 131.1kbits/s speed= 512x",
      "done"
    ])).toEqual(["size=     256KiB time=00:00:16.00 bitrate= 131.1kbits/s speed= 512x", "done"]);
  });
});

describe("ffprobe filter", () => {
  it("drops the banner and keeps duration and streams", async () => {
    const raw = fixture("ffprobe-default.txt");
    const r = await processOutput("ffprobe clip.mp4", raw, null, { exitCode: 0 });
    expect(r.filterId).toBe("ffprobe");
    expect(r.output).toContain("Duration: 00:00:04");
    expect(r.output).toMatch(/Stream #0:0.*Video: h264/);
    expect(r.output).toMatch(/Stream #0:1.*Audio: aac/);
    expect(r.output).not.toContain("ffprobe version");
    expect(r.output).not.toContain("configuration:");
    expect(bytes(r.output)).toBeLessThan(bytes(raw) * 0.5);
  });

  it("returns JSON output byte for byte", async () => {
    const raw = fixture("ffprobe-json.txt");
    const r = await processOutput("ffprobe -v error -show_format -show_streams -of json clip.mp4", raw, null, { exitCode: 0 });
    expect(r.output).toBe(raw);
    expect(JSON.parse(r.output).streams).toHaveLength(2);
  });
});

describe("yt-dlp filter", () => {
  it("keeps the chosen formats, the destinations, the final size and the merge", async () => {
    const raw = fixture("ytdlp-download.txt");
    const r = await processOutput("yt-dlp -f 299+140 -o clip.mp4 https://www.youtube.com/watch?v=aBcDeFgHiJk", raw, null, { exitCode: 0 });
    expect(r.filterId).toBe("yt-dlp");
    expect(r.output).toContain("Downloading 1 format(s): 299+140");
    expect(r.output).toContain("[download] Destination: clip.f299.mp4");
    expect(r.output).toContain("[download] 100% of   12.74MiB in 00:00:02");
    expect(r.output).toContain("[download] 100% of    1.94MiB in 00:00:00");
    expect(r.output).toContain('[Merger] Merging formats into "clip.mp4"');
    expect(r.output).not.toContain("ETA");
    expect(r.output).not.toContain("player API JSON");
    expect(r.output).not.toContain("pass -k to keep");
    expect(bytes(r.output)).toBeLessThan(bytes(raw) * 0.15);
  });

  it("keeps the error of a failed download", async () => {
    const r = await processOutput("yt-dlp https://www.youtube.com/watch?v=zZzZzZzZzZz", fixture("ytdlp-fail.txt"), null, { exitCode: 1 });
    expect(r.output).toContain("ERROR: [youtube] zZzZzZzZzZz: Video unavailable. This video is private");
  });

  it("matches yt-dlp and youtube-dl only", () => {
    for (const cmd of ["yt-dlp URL", "yt-dlp -x --audio-format mp3 URL", "youtube-dl URL"]) expect(matches("yt-dlp", cmd), cmd).toBe(true);
    for (const cmd of ["yt-dlp-wrapper URL", "pip install yt-dlp"]) expect(matches("yt-dlp", cmd), cmd).toBe(false);
  });
});

describe("blender filter", () => {
  it("keeps saved frames and render times, drops per-frame progress", async () => {
    const raw = fixture("blender-render.txt");
    const r = await processOutput("blender -b scene.blend -o out/f_ -s 60 -e 61 -a", raw, null, { exitCode: 0 });
    expect(r.filterId).toBe("blender");
    expect(r.output).toContain('Read blend: "/work/scene/scene.blend"');
    expect(r.output).toContain("Rendering animation (frames 60..61)");
    expect(r.output).toContain("Saved: '/work/scene/out/f_0060.png'");
    expect(r.output).toContain("Saved: '/work/scene/out/f_0061.png'");
    expect(r.output).toMatch(/\| Time: 00:09\.\d+ \(Saving: /);
    expect(r.output).toContain("Blender quit");
    expect(r.output).not.toContain("| Fra: ");
    expect(r.output).not.toContain("Synchronizing object");
    expect(bytes(r.output)).toBeLessThan(bytes(raw) * 0.05);
  });

  it("keeps a missing file error and a Python traceback", async () => {
    const miss = await processOutput("blender -b /work/absent/scene.blend -a", fixture("blender-fail.txt"), null, { exitCode: 0 });
    expect(miss.output).toContain('ERROR Cannot read file "/work/absent/scene.blend": No such file or directory');
    const py = await processOutput("blender -b --factory-startup -P casse.py", fixture("blender-python-error.txt"), null, { exitCode: 0 });
    expect(py.output).toContain("Traceback (most recent call last):");
    expect(py.output).toContain("AttributeError: 'CyclesRenderSettings' object has no attribute 'samplez'. Did you mean: 'samples'?");
  });

  it("matches Blender binaries and app paths only", () => {
    for (const cmd of ["blender -b scene.blend -a", "/Applications/Blender.app/Contents/MacOS/Blender -b s.blend -f 1", "blender.exe -b s.blend -a"]) {
      expect(matches("blender", cmd), cmd).toBe(true);
    }
    for (const cmd of ["blenderproc run x.py", "pip install blender-mcp"]) expect(matches("blender", cmd), cmd).toBe(false);
  });
});
