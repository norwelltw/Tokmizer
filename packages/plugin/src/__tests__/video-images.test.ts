import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { IMAGE_MAX_EDGE, imageSize, readImageOutput, smallerImage, smallerImageAsync } from "../video-images";
import { claudeReadUnrestricted } from "../hooks-host/pre-tool-rewrite";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let dir: string;
let cache: string;
const on = () => true;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tkr-video-images-")));
  cache = join(dir, "cache");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("image size from the file header", () => {
  it("reads PNG and JPEG sizes", () => {
    expect(imageSize(png(1102, 2000))).toEqual({ width: 1102, height: 2000 });
    const sof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x80, 0x04, 0x38, 0x03]);
    expect(imageSize(sof)).toEqual({ width: 1080, height: 1920 });
    expect(imageSize(Buffer.from("not an image"))).toBeNull();
  });
});

describe("smaller copy of a large image", () => {
  it("leaves the read alone off macOS, with video mode off, for small images and for -grand files", () => {
    const big = join(dir, "frame.png");
    writeFileSync(big, png(1600, 900));
    const small = join(dir, "small.png");
    writeFileSync(small, png(IMAGE_MAX_EDGE, 720));
    const grand = join(dir, "frame-grand.png");
    writeFileSync(grand, png(1600, 900));
    expect(smallerImage(big, { platform: "linux", cwd: dir, enabled: on, cacheDir: cache })).toBeNull();
    expect(smallerImage(big, { platform: "darwin", cwd: dir, enabled: () => false, cacheDir: cache })).toBeNull();
    expect(smallerImage(small, { platform: "darwin", cwd: dir, enabled: on, cacheDir: cache })).toBeNull();
    expect(smallerImage(grand, { platform: "darwin", cwd: dir, enabled: on, cacheDir: cache })).toBeNull();
    expect(smallerImage(join(dir, "notes.txt"), { platform: "darwin", cwd: dir, enabled: on, cacheDir: cache })).toBeNull();
    expect(smallerImage(join(dir, "missing.png"), { platform: "darwin", cwd: dir, enabled: on, cacheDir: cache })).toBeNull();
  });

  it("only answers Claude Code's Read with a file path", () => {
    expect(readImageOutput({ tool_name: "Bash", tool_input: { command: "ls" } }, { platform: "darwin" })).toBe("");
    expect(readImageOutput({ tool_name: "Read", tool_input: {} }, { platform: "darwin" })).toBe("");
  });
});

describe.skipIf(process.platform !== "darwin")("smaller copy with sips (macOS)", () => {
  it("reads a 1280 px copy, keeps the original and the other Read fields, and reuses the copy", () => {
    const big = join(dir, "planche.png");
    writeFileSync(big, png(2160, 1920));
    const before = statSync(big);
    const out = smallerImage(big, { platform: "darwin", cwd: dir, enabled: on, cacheDir: cache });
    expect(out).not.toBeNull();
    const copy = out as string;
    const dims = spawnSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", copy], { encoding: "utf8" }).stdout;
    expect(dims).toMatch(/pixelWidth: 1280/);
    expect(dims).toMatch(/pixelHeight: 113[78]/);
    expect(statSync(big).mtimeMs).toBe(before.mtimeMs);
    const made = statSync(copy).ino;
    expect(smallerImage(big, { platform: "darwin", cwd: dir, enabled: on, cacheDir: cache })).toBe(copy);
    expect(statSync(copy).ino).toBe(made);
  });

  it("answers the Read hook with the copy's path, allowed only as the original would be", () => {
    const big = join(dir, "frame.png");
    writeFileSync(big, png(1102, 2000));
    const ctx = { platform: "darwin" as const, enabled: on, cacheDir: cache, launchArgs: () => "", readUnrestricted: () => true };
    const read = (extra: Record<string, unknown>, c: Record<string, unknown> = {}) =>
      readImageOutput({ tool_name: "Read", cwd: dir, permission_mode: "default", tool_input: { file_path: big }, ...extra }, { ...ctx, ...c });
    const out = JSON.parse(read({ tool_input: { file_path: big, limit: 10 } })).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("allow");
    expect(out.updatedInput.limit).toBe(10);
    expect(out.updatedInput.file_path).toMatch(/-1280\.png$/);
    expect(out.updatedInput.file_path.startsWith(cache)).toBe(true);
    // Bypass mode: no permission answer, any folder, but Read rules still apply.
    const bypass = JSON.parse(read({ cwd: "/", permission_mode: "bypassPermissions" })).hookSpecificOutput;
    expect(bypass.permissionDecision).toBeUndefined();
    expect(bypass.updatedInput.file_path).toBe(out.updatedInput.file_path);
    expect(read({ permission_mode: "bypassPermissions" }, { readUnrestricted: () => false })).toBe("");
    // Outside the project, with a Read rule, a launch restriction, an unknown mode, a relative path, no cwd.
    expect(read({ cwd: join(dir, "cache") })).toBe("");
    expect(read({}, { readUnrestricted: () => false })).toBe("");
    expect(read({}, { launchArgs: () => "--disallowedTools Read" })).toBe("");
    expect(read({}, { launchArgs: () => null })).toBe("");
    expect(read({ permission_mode: "dontAsk" })).toBe("");
    expect(read({ tool_input: { file_path: "frame.png" } })).toBe("");
    expect(read({ cwd: undefined })).toBe("");
  });

  it("makes the copy without blocking, and does not retry an image sips cannot read", async () => {
    const big = join(dir, "frame.png");
    writeFileSync(big, png(1600, 900));
    const ctx = { platform: "darwin" as const, cwd: dir, enabled: on, cacheDir: cache };
    const copy = await smallerImageAsync(big, ctx, 5000);
    expect(copy).toMatch(/-1280\.png$/);
    expect(await smallerImageAsync(big, ctx, 0)).toBe(copy);
    const broken = join(dir, "broken.png");
    writeFileSync(broken, png(1600, 900).subarray(0, 40));
    expect(await smallerImageAsync(broken, ctx, 5000)).toBeNull();
    expect(readdirSync(cache).filter((n) => n.endsWith(".fail"))).toHaveLength(1);
    expect(smallerImage(broken, ctx)).toBeNull();
    expect(readdirSync(cache).some((n) => n.includes(".tmp"))).toBe(false);
  });

  it("returns null when the wait runs out, and the copy is ready for the next read", async () => {
    const big = join(dir, "frame.png");
    writeFileSync(big, png(1600, 900));
    const ctx = { platform: "darwin" as const, cwd: dir, enabled: on, cacheDir: cache };
    expect(await smallerImageAsync(big, ctx, 0)).toBeNull();
    for (let i = 0; i < 100 && !readdirSync(cache).some((n) => n.endsWith("-1280.png")); i++) await new Promise((r) => setTimeout(r, 50));
    expect(smallerImage(big, ctx)).toMatch(/-1280\.png$/);
    expect(existsSync(big)).toBe(true);
  });
});

describe("Read rules in Claude Code settings", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is unrestricted without Read rules, restricted by a Read deny or ask rule or an unreadable file", () => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    vi.stubEnv("HOME", home);
    const dirs = { configDir: join(home, ".claude"), projectDir: project };
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] } }));
    expect(claudeReadUnrestricted(project, dirs)).toBe(true);
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ permissions: { deny: ["Read(./secrets/**)"] } }));
    expect(claudeReadUnrestricted(project, dirs)).toBe(false);
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ permissions: { ask: ["Read"] } }));
    expect(claudeReadUnrestricted(project, dirs)).toBe(false);
    writeFileSync(join(project, ".claude", "settings.local.json"), "{ not json");
    expect(claudeReadUnrestricted(project, dirs)).toBe(false);
  });
});
