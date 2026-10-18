#!/usr/bin/env node
import { build } from "esbuild";
import { chmodSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { bundleDefines } from "./bundle-config.mjs";
import { copyNativeArtifacts, copySingleArtifacts } from "./native-artifacts.mjs";

// Clean the output dir cross-platform (was `rm -rf dist` in the npm script,
// which fails on Windows where rm is not available).
rmSync("dist", { recursive: true, force: true });

const defines = await bundleDefines(process.cwd());

const entries = [
  "src/index.ts",
  "src/prod-public-key.ts",
  "src/bin/tkr.ts",
  "src/bin/tkr-exec.ts",
  "src/bin/tkr-shim.ts",
  "src/bin/tkr-codex-hook.ts",
  "src/bin/tkr-cursor-hook.ts",
  "src/bin/tkr-gemini-hook.ts",
  "src/bin/tkr-agent-hook.ts",
  "src/bin/tkr-copilot-hook.ts",
  "src/bin/tkr-droid-hook.ts",
  "src/bin/tkr-trae-hook.ts",
  "src/bin/tkr-qwen-hook.ts",
  "src/bin/tkr-crush-hook.ts",
  "src/bin/tkr-junie-hook.ts",
  "src/bin/tkr-zcode-hook.ts",
  "src/bin/tkr-grok-hook.ts",
  "src/bin/tkr-context-hook.ts",
  "src/bin/tkr-daemon.ts",
  "src/bin/tkr-processor.ts",
  "src/hooks-host/pre-tool-use.ts",
  "src/hooks-host/post-tool-use.ts",
  "src/hooks-host/reducer-session-start.ts",
  "src/hooks-host/reducer-prompt-submit.ts",
  "src/hooks-host/reducer-stop.ts",
  "src/hooks-host/session-recap.ts",
  "src/hooks-host/command-expansion.ts"
];

await build({
  entryPoints: entries,
  outdir: "dist",
  outbase: "src",
  bundle: true,
  minify: true,
  define: { ...defines, "process.env.TOKMIZER_SINGLE_BINARY": "undefined" },
  platform: "node",
  format: "esm",
  target: "node18",
  banner: {
    js: 'import { createRequire as __tkrCreateRequire } from "node:module"; const require = __tkrCreateRequire(import.meta.url);'
  },
  logLevel: "warning"
});

// Set the executable bit on the bin entrypoints. Done here (cross-platform,
// guarded) instead of a `chmod +x` in the npm build script, which is a Unix-only
// command that fails on Windows. Windows uses npm's generated .cmd shims and has
// no exec bit, so this is a no-op there.
if (process.platform !== "win32") {
  for (const b of ["tkr", "tkr-exec", "tkr-shim", "tkr-codex-hook", "tkr-cursor-hook", "tkr-gemini-hook", "tkr-agent-hook", "tkr-copilot-hook", "tkr-droid-hook", "tkr-trae-hook", "tkr-qwen-hook", "tkr-crush-hook", "tkr-junie-hook", "tkr-zcode-hook", "tkr-grok-hook", "tkr-context-hook", "tkr-daemon", "tkr-processor"]) {
    chmodSync(`dist/bin/${b}.js`, 0o755);
  }
}

copyFileSync("dist/bin/tkr-exec.js", "dist/bin/tkr-exec");
writeFileSync("dist/bin/tkr-shim.stable", "1\n");
if (process.platform !== "win32") chmodSync("dist/bin/tkr-exec", 0o755);
copyNativeArtifacts(process.cwd());
copySingleArtifacts(process.cwd());

console.log("bundle: done");
