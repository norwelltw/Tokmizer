import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVideoMode, setVideoMode, videoModeEnabled, videoProjectRoot } from "../video-mode";
import { formatTips, unseenTips, videoTips, type TipContext } from "../video-tips";
import { processCapturedOutput } from "../exec/wrapper";
import { Settings } from "../contracts";
import { loadSettingsCache } from "../settings-cache";

vi.mock("../state", () => ({ loadState: vi.fn().mockResolvedValue({ token: "fixture", plan: "pro", allowedFilters: [] }) }));
vi.mock("../settings-cache", () => ({ loadSettingsCache: vi.fn() }));
vi.mock("../learn/recorder", () => ({ recordEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../learn/telemetry", () => ({ recordTelemetry: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../daemon/resolver", () => ({ installDaemonResolver: vi.fn(), closeDaemonResolver: vi.fn() }));

const mac: TipContext = { platform: "darwin", totalMemBytes: 32 * 1024 ** 3, cpus: 10 };
const linux: TipContext = { platform: "linux", totalMemBytes: 32 * 1024 ** 3, cpus: 10 };
let dir: string;
let home: string;
let project: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tkr-video-")));
  home = join(dir, "home");
  project = join(dir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(project, "shots"));
  vi.stubEnv("TOKMIZER_HOME", home);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "claude"));
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.mocked(loadSettingsCache).mockResolvedValue(Settings.parse({ telemetryOptIn: false }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("video mode setting", () => {
  it("is off by default and writes nothing when turned off", async () => {
    expect(videoModeEnabled(project)).toBe(false);
    await setVideoMode(false, { global: false, cwd: project });
    expect(existsSync(home)).toBe(false);
  });

  it("turns on for one project, from any folder inside it, and off again", async () => {
    await setVideoMode(true, { global: false, cwd: join(project, "shots") });
    expect(readVideoMode()).toEqual({ global: false, projects: [project] });
    expect(videoProjectRoot(join(project, "shots"))).toBe(project);
    expect(videoModeEnabled(join(project, "shots"))).toBe(true);
    expect(videoModeEnabled(dir)).toBe(false);
    expect(videoModeEnabled(`${project}-other`)).toBe(false);
    await setVideoMode(false, { global: false, cwd: project });
    expect(videoModeEnabled(project)).toBe(false);
    expect(existsSync(join(home, "video-mode.json"))).toBe(false);
  });

  it("turns on everywhere with the global scope and ignores a malformed file", async () => {
    await setVideoMode(true, { global: true });
    expect(videoModeEnabled(dir)).toBe(true);
    writeFileSync(join(home, "video-mode.json"), "{broken");
    expect(videoModeEnabled(dir)).toBe(false);
  });
});

describe("render tips", () => {
  const ids = (cmd: string, ctx = mac, output = "") => videoTips(cmd, output, ctx).map((tip) => tip.id);

  it("reports a slow setting only when the machine can do better", () => {
    expect(ids("npx hyperframes render --low-memory-mode --gpu")).toEqual(["render-low-memory"]);
    expect(ids("npx hyperframes render --low-memory-mode --gpu", { ...mac, totalMemBytes: 8 * 1024 ** 3 })).toEqual([]);
    expect(ids("hyperframes render --workers 1 --gpu")).toEqual(["render-one-worker"]);
    expect(ids("hyperframes render -w 1 --gpu", { ...mac, cpus: 2 })).toEqual([]);
    expect(ids("hyperframes render --no-experimental-fast-capture --gpu")).toEqual(["render-fast-capture-off"]);
    expect(ids("hyperframes render --no-page-side-compositing --gpu")).toEqual(["render-layered-compositing"]);
    expect(ids("hyperframes render --no-page-side-compositing --format webm")).toEqual([]);
    expect(ids("hyperframes render --no-browser-gpu", linux)).toEqual(["render-software-browser"]);
  });

  it("mentions the unused hardware encoder on macOS mp4 renders only", () => {
    expect(ids("npx -y hyperframes@latest render -o out.mp4")).toEqual(["render-gpu-encode"]);
    expect(ids("hyperframes render --gpu")).toEqual([]);
    expect(ids("hyperframes render --docker")).toEqual([]);
    expect(ids("hyperframes render --format hls")).toEqual([]);
    expect(ids("hyperframes render -o out.webm")).toEqual([]);
    expect(ids("hyperframes render", linux)).toEqual([]);
  });

  it("caps the tips at two and stays silent for other commands", () => {
    expect(ids("hyperframes render --low-memory-mode --no-browser-gpu --no-page-side-compositing")).toHaveLength(2);
    expect(ids("hyperframes check")).toEqual([]);
    expect(ids("git status")).toEqual([]);
    expect(ids("echo hyperframes render")).toEqual(["render-gpu-encode"]);
  });

  it("spots a CPU encoder in an ffmpeg command or its output", () => {
    expect(ids("ffmpeg -i in.mov -c:v libx264 out.mp4")).toEqual(["ffmpeg-hardware-encoder"]);
    expect(videoTips("ffmpeg -i in.mov -c:v libx265 out.mp4", "", mac)[0]!.text).toContain("hevc_videotoolbox");
    expect(ids("ffmpeg -i in.mov out.mp4", mac, "Stream #0:0 -> #0:0 (prores (native) -> h264 (libx264))")).toEqual(["ffmpeg-hardware-encoder"]);
    expect(ids("ffmpeg -i in.mov -c:v h264_videotoolbox out.mp4")).toEqual([]);
    expect(ids("ffmpeg -i in.mov -c:v libx264 out.mp4", linux)).toEqual([]);
    expect(ids("ffmpeg -i in.mov -c:v copy out.mp4")).toEqual([]);
  });

  it("suggests the GPU for a background Cycles render that does not choose its device", () => {
    const cycles = "00:00.263  render           | Engine: Cycles";
    expect(ids("blender -b scene.blend -a", mac, cycles)).toEqual(["blender-cycles-device"]);
    expect(videoTips("blender -b scene.blend -a", cycles, mac)[0]!.text).toContain("--cycles-device METAL");
    expect(videoTips("blender -b scene.blend -a", cycles, linux)[0]!.text).toContain("--cycles-device OPTIX");
    expect(ids("/Applications/Blender.app/Contents/MacOS/Blender -b s.blend -f 1", mac, cycles)).toEqual(["blender-cycles-device"]);
    expect(ids("blender -b scene.blend -a -- --cycles-device METAL", mac, cycles)).toEqual([]);
    expect(ids("blender -b scene.blend -a", mac, "00:00.263  render           | Engine: EEVEE")).toEqual([]);
    expect(ids("blender scene.blend", mac, cycles)).toEqual([]);
  });

  it("shows each tip once per session", () => {
    const tips = videoTips("hyperframes render", "", mac);
    expect(unseenTips(tips, "session-1")).toEqual(tips);
    expect(unseenTips(tips, "session-1")).toEqual([]);
    expect(unseenTips(tips, "session-2")).toEqual(tips);
    expect(unseenTips(tips, undefined)).toEqual(tips);
    expect(unseenTips(tips, "../escape")).toEqual(tips);
    expect(readdirSync(join(home, "sessions")).sort()).toEqual(["session-1.tips", "session-2.tips"]);
    expect(formatTips(tips)).toMatch(/^\[tkr tip\] /);
  });
});

describe("tips in delivered output", () => {
  const run = (argv: string[], exitCode = 0) =>
    processCapturedOutput({ argv, stdout: "Rendered out.mp4\n", stderr: "", exitCode, truncated: false, stderrTruncated: false }, { yolo: false, env: process.env, cwd: project, resolver: async () => null });

  it("adds nothing while video mode is off", async () => {
    expect((await run(["hyperframes", "render", "--low-memory-mode", "--gpu"])).stdout).toBe("Rendered out.mp4\n");
  });

  it("appends the tip after the command output when video mode is on, never after a failure", async () => {
    await setVideoMode(true, { global: false, cwd: project });
    const result = await run(["hyperframes", "render", "--no-browser-gpu", "--gpu"]);
    expect(result.stdout).toMatch(/^Rendered out\.mp4\n\[tkr tip\] --no-browser-gpu /);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect((await run(["hyperframes", "render", "--no-browser-gpu", "--gpu"], 1)).stdout).toBe("Rendered out.mp4\n");
    expect((await run(["git", "status"])).stdout).toBe("Rendered out.mp4\n");
  });
});
