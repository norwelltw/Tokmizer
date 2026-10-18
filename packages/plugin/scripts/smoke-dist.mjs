import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "tkr-dist-smoke-"));
const home = join(root, ".tokmizer");
mkdirSync(home);
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  TOKMIZER_HOME: home,
  TOKMIZER_AUTO_UPDATE: "0",
  TOKMIZER_NETWORK: "off"
};

function stopProcessors() {
  const run = join(home, "run");
  if (!existsSync(run)) return;
  for (const name of readdirSync(run).filter((entry) => entry.endsWith(".pid"))) {
    try {
      process.kill(Number(readFileSync(join(run, name), "utf8")), "SIGTERM");
    } catch {}
  }
}

try {
  const echoed = execFileSync(process.execPath, [join(directory, "dist", "bin", "tkr-exec.js"), "echo", "dist-smoke-ok"], { env, encoding: "utf8", timeout: 30000 });
  if (!echoed.includes("dist-smoke-ok")) throw new Error(`tkr-exec smoke printed: ${echoed}`);
  execFileSync(process.execPath, [join(directory, "dist", "bin", "tkr.js"), "help"], { env, stdio: ["ignore", "ignore", "inherit"], timeout: 30000 });
  console.log("dist smoke: ok");
} finally {
  stopProcessors();
  rmSync(root, { recursive: true, force: true });
}
