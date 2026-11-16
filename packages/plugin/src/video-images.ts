import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import { tokmizerHome } from "./paths";
import { videoModeEnabled } from "./video-mode";
import { claudeLaunchArgs, claudeLaunchRestricted, claudeReadUnrestricted, currentClaudeDirs, type ClaudeDirs } from "./hooks-host/pre-tool-rewrite";

// Video mode: an image Claude reads goes in at 1280 px on its longest side.
// The file on disk is never changed; Claude reads a smaller copy. A file whose
// name contains "-grand" (or "-full") is read as it is.
export const IMAGE_MAX_EDGE = 1280;
const KEEP_MS = 3 * 24 * 3600 * 1000;
const SIPS_TIMEOUT_MS = 2500;
const EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

export type ImageContext = { platform: NodeJS.Platform; cwd: string; enabled?: (cwd: string) => boolean; cacheDir?: string };

function header(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } finally {
    closeSync(fd);
  }
}

export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function prune(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > KEEP_MS) rmSync(file, { force: true });
    } catch {
      // Another session removed it.
    }
  }
}

// Cheap checks on the name only, before any file or settings access.
function candidate(file: string, ctx: ImageContext): boolean {
  if (ctx.platform !== "darwin" || !isAbsolute(file)) return false;
  if (!EXTENSIONS.has(extname(file).toLowerCase()) || /-(grand|full)\b/i.test(basename(file))) return false;
  return (ctx.enabled ?? videoModeEnabled)(ctx.cwd);
}

type Make = { kind: "make"; file: string; out: string; tmp: string; fail: string };
type Plan = { kind: "skip" } | { kind: "ready"; out: string } | Make;

function plan(file: string, ctx: ImageContext): Plan {
  if (!candidate(file, ctx)) return { kind: "skip" };
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { kind: "skip" };
    const size = imageSize(header(file));
    if (!size || Math.max(size.width, size.height) <= IMAGE_MAX_EDGE) return { kind: "skip" };
    const dir = ctx.cacheDir ?? join(tokmizerHome(), "images");
    const ext = extname(file).toLowerCase();
    const key = createHash("sha256").update(`${file}\0${stat.size}\0${stat.mtimeMs}`).digest("hex").slice(0, 24);
    const out = join(dir, `${key}-${IMAGE_MAX_EDGE}${ext}`);
    const fail = `${out}.fail`;
    const now = new Date();
    if (existsSync(out)) {
      // Fresh mtime so another session's prune keeps the copy Claude is about to read.
      utimesSync(out, now, now);
      return { kind: "ready", out };
    }
    if (existsSync(fail)) return { kind: "skip" };
    mkdirSync(dir, { recursive: true });
    prune(dir, now.getTime());
    return { kind: "make", file, out, fail, tmp: `${out}.${process.pid}.${now.getTime()}.tmp${ext}` };
  } catch {
    return { kind: "skip" };
  }
}

// Keeps the finished copy, or marks the image so a failing resize is not retried.
function settle(p: Make, ok: boolean): string | null {
  try {
    if (ok && existsSync(p.tmp)) {
      renameSync(p.tmp, p.out);
      return p.out;
    }
    rmSync(p.tmp, { force: true });
    writeFileSync(p.fail, "");
  } catch {
    // Cache folder gone or not writable: Claude reads the original.
  }
  return null;
}

function sipsArgs(p: Make): string[] {
  return ["-Z", String(IMAGE_MAX_EDGE), p.file, "--out", p.tmp];
}

// Path of the smaller copy Claude should read instead, or null to read the file as it is.
export function smallerImage(file: string, ctx: ImageContext): string | null {
  const p = plan(file, ctx);
  if (p.kind !== "make") return p.kind === "ready" ? p.out : null;
  const run = spawnSync("/usr/bin/sips", sipsArgs(p), { stdio: "ignore", timeout: SIPS_TIMEOUT_MS });
  return settle(p, run.status === 0);
}

// Same without blocking the caller: waits up to waitMs, then lets Claude read the
// original this time while the copy finishes for the next read.
export function smallerImageAsync(file: string, ctx: ImageContext, waitMs: number): Promise<string | null> {
  const p = plan(file, ctx);
  if (p.kind !== "make") return Promise.resolve(p.kind === "ready" ? p.out : null);
  return new Promise((done) => {
    const timer = setTimeout(() => done(null), waitMs);
    const child = spawn("/usr/bin/sips", sipsArgs(p), { stdio: "ignore", timeout: SIPS_TIMEOUT_MS });
    let finished = false;
    const end = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(settle(p, ok));
    };
    child.on("error", () => end(false));
    child.on("close", (code) => end(code === 0));
  });
}

// Modes where Claude Code reads a file inside the project without asking.
const QUIET_READ_MODES = new Set(["default", "acceptEdits", "plan", "auto"]);

function inside(file: string, dir: string): boolean {
  try {
    const f = realpathSync(file);
    const d = realpathSync(dir);
    return f.startsWith(d.endsWith(sep) ? d : d + sep);
  } catch {
    return false;
  }
}

export type ReadHookContext = Omit<ImageContext, "cwd"> & {
  claudeDirs?: ClaudeDirs | undefined;
  launchArgs?: (() => string | null) | undefined;
  readUnrestricted?: (cwd: string) => boolean;
};

type ReadPlan = { file: string; cwd: string; bypass: boolean; input: Record<string, unknown> };

// The copy lives in ~/.tokmizer/images, outside the project, so Claude Code would
// ask before reading it, and its Read rules would no longer match. Tokmizer swaps
// the path only where reading the original would not have asked: no Read rule in
// deny or ask, no restriction passed at launch, and either bypass mode or an image
// inside the project in a mode that reads project files quietly.
function readPlan(payload: Record<string, unknown>, ctx: ReadHookContext): ReadPlan | null {
  if (payload.tool_name !== "Read" || typeof payload.cwd !== "string") return null;
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const file = (input as Record<string, unknown>).file_path;
  const cwd = payload.cwd;
  if (typeof file !== "string" || !candidate(file, { ...ctx, cwd })) return null;
  const mode = typeof payload.permission_mode === "string" ? payload.permission_mode : "default";
  const bypass = mode === "bypassPermissions";
  if (!bypass && (!QUIET_READ_MODES.has(mode) || !inside(file, cwd))) return null;
  if (claudeLaunchRestricted((ctx.launchArgs ?? claudeLaunchArgs)())) return null;
  const unrestricted = ctx.readUnrestricted ?? ((dir: string) => claudeReadUnrestricted(dir, ctx.claudeDirs ?? currentClaudeDirs()));
  if (!unrestricted(cwd)) return null;
  return { file, cwd, bypass, input: input as Record<string, unknown> };
}

function answer(rp: ReadPlan, small: string | null): string {
  if (!small) return "";
  const updatedInput = { ...rp.input, file_path: small };
  return JSON.stringify({
    hookSpecificOutput: rp.bypass
      ? { hookEventName: "PreToolUse", updatedInput }
      : { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Tokmizer: 1280 px copy of an image in this project (video mode)", updatedInput }
  });
}

// PreToolUse answer for Claude Code's Read tool, or "" to leave the call alone.
export function readImageOutput(payload: Record<string, unknown>, ctx: ReadHookContext): string {
  const rp = readPlan(payload, ctx);
  return rp ? answer(rp, smallerImage(rp.file, { ...ctx, cwd: rp.cwd })) : "";
}

export async function readImageOutputAsync(payload: Record<string, unknown>, ctx: ReadHookContext, waitMs: number): Promise<string> {
  const rp = readPlan(payload, ctx);
  return rp ? answer(rp, await smallerImageAsync(rp.file, { ...ctx, cwd: rp.cwd }, waitMs)) : "";
}
