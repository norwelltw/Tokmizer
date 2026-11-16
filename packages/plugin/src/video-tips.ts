import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { arch, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { tokmizerHome } from "./paths";

export type TipContext = { platform: NodeJS.Platform; totalMemBytes: number; cpus: number; arch?: string };
export type VideoTip = { id: string; text: string };

const MAX_TIPS = 2;
const GIB = 1024 ** 3;
const LOW_MEMORY_LIMIT_BYTES = 8 * GIB;
const RENDER_RE = /(?:^|[\s/;&|(])hyperframes(?:@[^\s]+)?\s+render\b([^;&|\n]*)/;
const FFMPEG_RE = /(?:^|[\s/;&|(])ffmpeg\s([^;&|\n]*)/;
const BLENDER_RE = /(?:^|[\s/;&|(])[Bb]lender(?:\.exe)?\s([^;&|\n]*)/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function hostContext(): TipContext {
  return { platform: process.platform, totalMemBytes: totalmem(), cpus: cpus().length, arch: arch() };
}

function has(args: string, flag: string): boolean {
  return new RegExp(`(?:^|\\s)${flag}(?:\\s|$)`).test(args);
}

function value(args: string, ...flags: string[]): string | null {
  for (const flag of flags) {
    const m = new RegExp(`(?:^|\\s)${flag}(?:=|\\s+)(\\S+)`).exec(args);
    if (m) return m[1]!.replace(/^['"]|['"]$/g, "");
  }
  return null;
}

function renderTips(args: string, ctx: TipContext): VideoTip[] {
  const tips: VideoTip[] = [];
  const lowMemory = has(args, "--low-memory-mode") || /(?:^|\s)--low-memory-mode=true(?:\s|$)/.test(args);
  if (lowMemory && ctx.totalMemBytes > LOW_MEMORY_LIMIT_BYTES) {
    tips.push({
      id: "render-low-memory",
      text: `--low-memory-mode pins the render to 1 worker and screenshot capture. This machine has ${Math.round(ctx.totalMemBytes / GIB)} GB of RAM: without the flag hyperframes picks its workers itself.`
    });
  }
  if (!lowMemory && value(args, "--workers", "-w") === "1" && ctx.cpus >= 4) {
    tips.push({ id: "render-one-worker", text: `--workers 1 captures on a single Chrome process. --workers auto uses the ${ctx.cpus} cores of this machine.` });
  }
  if (ctx.platform === "darwin" && (has(args, "--no-experimental-fast-capture") || /(?:^|\s)--experimental-fast-capture=false(?:\s|$)/.test(args))) {
    tips.push({ id: "render-fast-capture-off", text: "Fast capture is turned off. On macOS it is about 2x faster and falls back to screenshots by itself when a composition is not compatible." });
  }
  const format = value(args, "--format") ?? (/\.(webm|mov|gif)(?:['"]?)(?:\s|$)/.exec(args)?.[1] ?? "mp4");
  if (has(args, "--no-page-side-compositing") && (format === "mp4" || format === "hls")) {
    tips.push({ id: "render-layered-compositing", text: "--no-page-side-compositing forces the layered blend. Page-side compositing is about 6x faster for shader transitions in SDR mp4 and hls renders." });
  }
  if (has(args, "--no-browser-gpu")) {
    tips.push({ id: "render-software-browser", text: "--no-browser-gpu captures with software rendering. Without it hyperframes probes the GPU and falls back to software only when none is found." });
  }
  if (ctx.platform === "darwin" && format === "mp4" && !has(args, "--gpu") && !has(args, "--docker")) {
    tips.push({ id: "render-gpu-encode", text: "This Mac has a hardware video encoder that this render does not use. --gpu encodes with it: faster, with a different size and quality trade-off than the default encoder, so it suits drafts best." });
  }
  return tips;
}

function ffmpegTips(args: string, output: string, ctx: TipContext): VideoTip[] {
  if (ctx.platform !== "darwin" || /videotoolbox/.test(args)) return [];
  const software = /(?:^|\s)-(?:c:v|codec:v|vcodec)\s+(libx264|libx265)(?:\s|$)/.exec(args)?.[1] ?? /-> (?:h264|hevc) \((libx264|libx265)\)/.exec(output)?.[1];
  if (!software) return [];
  const hardware = software === "libx265" ? "hevc_videotoolbox" : "h264_videotoolbox";
  return [{ id: "ffmpeg-hardware-encoder", text: `This encode uses ${software} on the CPU. ${hardware} uses this Mac's hardware encoder: faster, with a larger file at the same visual quality, so it suits drafts best.` }];
}

function blenderTips(args: string, output: string, ctx: TipContext): VideoTip[] {
  if (!/(?:^|\s)-b(?:\s|$)|(?:^|\s)--background(?:\s|$)/.test(args)) return [];
  if (!/\| Engine: Cycles\b/.test(output) || /(?:^|\s)--cycles-device(?:=|\s)/.test(args)) return [];
  const device = ctx.platform === "darwin" ? "METAL" : "OPTIX";
  const others = ctx.platform === "darwin" ? "" : " (CUDA on older NVIDIA cards, HIP on AMD, ONEAPI on Intel)";
  return [{
    id: "blender-cycles-device",
    text: `Cycles uses the device saved in Blender's preferences, the CPU on a fresh install. Add -- --cycles-device ${device}${others} to render on the GPU: 2x to 5x faster on M4 Pro tests. The first GPU render compiles its kernels once.`
  }];
}

const BLENDER_BIN_RE = /^blender(?:\.exe)?$/i;
const BLENDER_RENDER_FLAGS = new Set(["-a", "--render-anim", "-f", "--render-frame"]);
const BLENDER_PYTHON_FLAGS = new Set(["-P", "--python", "--python-expr", "--python-text", "--python-console"]);

// Settings video mode applies to a command before it runs. Only settings that
// keep the scene and output settings as they are: a plain background Blender render goes to the
// Apple GPU. A command carrying `--` or a Python script is left as written,
// since a script may parse the arguments after `--` and reject a new one.
export function autoVideoArgs(argv: string[], ctx: TipContext = hostContext()): { argv: string[]; added: string | null } {
  const same = { argv, added: null };
  const [head, ...args] = argv;
  if (!head || !BLENDER_BIN_RE.test(head.split(/[\\/]/).pop() ?? "")) return same;
  if (ctx.platform !== "darwin" || ctx.arch !== "arm64") return same;
  if (!args.includes("-b") && !args.includes("--background")) return same;
  if (!args.some((arg) => BLENDER_RENDER_FLAGS.has(arg))) return same;
  if (args.includes("--") || args.some((arg) => BLENDER_PYTHON_FLAGS.has(arg))) return same;
  return { argv: [...argv, "--", "--cycles-device", "METAL"], added: "-- --cycles-device METAL" };
}

export function autoVideoNotice(added: string): string {
  return `[tkr video] Added ${added}: Blender renders on the GPU with the same scene settings. tkr video off runs commands as written.`;
}

export function videoTips(cmdLine: string, output: string, ctx: TipContext = hostContext()): VideoTip[] {
  const render = RENDER_RE.exec(cmdLine);
  if (render) return renderTips(render[1] ?? "", ctx).slice(0, MAX_TIPS);
  const ffmpeg = FFMPEG_RE.exec(cmdLine);
  if (ffmpeg) return ffmpegTips(ffmpeg[1] ?? "", output, ctx).slice(0, MAX_TIPS);
  const blender = BLENDER_RE.exec(cmdLine);
  if (blender) return blenderTips(blender[1] ?? "", output, ctx).slice(0, MAX_TIPS);
  return [];
}

export function unseenTips(tips: VideoTip[], sessionId: string | undefined): VideoTip[] {
  if (tips.length === 0 || !sessionId || !SESSION_ID_RE.test(sessionId)) return tips;
  const dir = join(tokmizerHome(), "sessions");
  const file = join(dir, `${sessionId}.tips`);
  let seen: Set<string>;
  try {
    seen = new Set(readFileSync(file, "utf8").split("\n"));
  } catch {
    seen = new Set();
  }
  const fresh = tips.filter((tip) => !seen.has(tip.id));
  if (fresh.length === 0) return fresh;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(file, fresh.map((tip) => `${tip.id}\n`).join(""), { mode: 0o600 });
  } catch {}
  return fresh;
}

export function formatTips(tips: VideoTip[]): string {
  return tips.map((tip) => `[tkr tip] ${tip.text}`).join("\n");
}
