import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHIM_DIR_RE = /[\\/]\.tokmizer[\\/]shims[\\/]?$/;

export default function setup(): () => void {
  const realHome = userInfo().homedir;
  const sandbox = mkdtempSync(join(tmpdir(), "tkr-vitest-sandbox-"));
  const violations = join(sandbox, "real-home-violations.log");
  writeFileSync(violations, "");
  const guard = fileURLToPath(new URL("./vitest.home-guard.mjs", import.meta.url));
  process.env.TOKMIZER_TEST_REAL_HOME = realHome;
  process.env.TOKMIZER_TEST_FORBIDDEN_HOME = join(realHome, ".tokmizer");
  process.env.TOKMIZER_TEST_VIOLATIONS = violations;
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.TOKMIZER_HOME = join(sandbox, ".tokmizer");
  process.env.TOKMIZER_BASE_URL ??= "http://127.0.0.1:9";
  process.env.PATH = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry && !SHIM_DIR_RE.test(entry)).join(delimiter);
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(guard).href}`].filter(Boolean).join(" ");
  return () => {
    const found = readFileSync(violations, "utf8").trim();
    rmSync(sandbox, { recursive: true, force: true });
    if (!found) return;
    process.exitCode = 1;
    throw new Error(`Tests touched the real Tokmizer home (${process.env.TOKMIZER_TEST_FORBIDDEN_HOME}) or the production server:\n${found}`);
  };
}
