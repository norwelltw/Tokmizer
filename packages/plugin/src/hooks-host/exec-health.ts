import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokmizerHome } from "../paths";
import { directlyExecutable, fileMagic, resolvableHead } from "./shell-heads";

const PROBE_FILE = "exec-probe.json";

type ProbeRecord = { key: string; ok: boolean; at: number; skipped: number };

const RETRY_MS = 60_000;

function probeFile(): string {
  return join(tokmizerHome(), PROBE_FILE);
}

function readRecord(file: string): ProbeRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed == null || typeof parsed !== "object") return null;
    const r = parsed as Partial<ProbeRecord>;
    if (typeof r.key !== "string" || typeof r.ok !== "boolean") return null;
    return {
      key: r.key,
      ok: r.ok,
      at: typeof r.at === "number" ? r.at : 0,
      skipped: typeof r.skipped === "number" && r.skipped >= 0 ? r.skipped : 0
    };
  } catch {
    return null;
  }
}

function writeRecord(file: string, record: ProbeRecord): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {}
}

function nativeCheck(path: string): boolean {
  try {
    const out = execFileSync(path, ["--native-check"], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    return out.startsWith("tokmizer-native ");
  } catch {
    return false;
  }
}

function shebangUsable(path: string, pathEnv: string | undefined): boolean {
  try {
    const line = readFileSync(path, "utf8").split("\n", 1)[0]!;
    const words = line.slice(2).trim().split(/\s+/);
    const interpreter = words[0] ?? "";
    if (interpreter === "/usr/bin/env") return resolvableHead(words[1] ?? "", undefined, pathEnv);
    return directlyExecutable(interpreter);
  } catch {
    return false;
  }
}

function probeKey(path: string, script: boolean, pathEnv: string | undefined): string {
  try {
    const st = statSync(path);
    return [path, st.size, st.mtimeMs, st.ino, st.mode, script ? pathEnv ?? "" : ""].join("|");
  } catch {
    return `${path}|missing`;
  }
}

export function execUsable(
  path: string,
  platform: NodeJS.Platform = process.platform,
  pathEnv: string | undefined = process.env.PATH,
  file: string = probeFile(),
  now: number = Date.now()
): boolean {
  const script = platform !== "win32" && fileMagic(path) === "#!";
  const key = probeKey(path, script, pathEnv);
  const cached = readRecord(file);
  if (cached?.key === key && (cached.ok || now - cached.at < RETRY_MS)) return cached.ok;
  const ok = directlyExecutable(path, platform) && (script ? shebangUsable(path, pathEnv) : nativeCheck(path));
  writeRecord(file, { key, ok, at: now, skipped: (cached?.skipped ?? 0) + (ok ? 0 : 1) });
  return ok;
}

export function execSkips(file: string = probeFile()): number {
  return readRecord(file)?.skipped ?? 0;
}
