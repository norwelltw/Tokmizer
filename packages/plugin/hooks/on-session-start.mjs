import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname, basename } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";

const drained = new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve();
  const timer = setTimeout(resolve, 2000);
  process.stdin.on("data", () => {}).once("end", () => { clearTimeout(timer); resolve(); }).once("error", () => { clearTimeout(timer); resolve(); });
});

const home = process.env.TOKMIZER_HOME || join(homedir(), ".tokmizer");
const single = process.env.TOKMIZER_SINGLE_BINARY === "1";
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || (single ? join(dirname(process.execPath), "..", "..") : join(dirname(fileURLToPath(import.meta.url)), ".."));
const networkOff =
  ["0", "off", "false", "no"].includes(String(process.env.TOKMIZER_NETWORK ?? "").trim().toLowerCase()) ||
  existsSync(join(home, "network-off"));
const userMessages = [];
let context = "";

try {
  const hooksFile = join(pluginRoot, "hooks", "hooks.json");
  const installer = join(pluginRoot, "scripts", "install-native.mjs");
  const { version } = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  const attempt = join(home, `native-attempt-${version}`);
  if (!single && process.env.TOKMIZER_NATIVE_EXEC !== "0" && existsSync(installer) && !existsSync(attempt) && readFileSync(hooksFile, "utf8").includes('"node \\"${CLAUDE_PLUGIN_ROOT}')) {
    mkdirSync(home, { recursive: true });
    writeFileSync(attempt, String(Date.now()), { mode: 0o600 });
    spawn(process.execPath, [installer, "--native-only"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
} catch {}

try {
  const srcDir = join(pluginRoot, "command-templates");
  const destDir = process.env.TOKMIZER_CLAUDE_COMMANDS_DIR || join(homedir(), ".claude", "commands");
  const MARKER = "managed-by: tokmizer";
  if (existsSync(srcDir)) {
    mkdirSync(destDir, { recursive: true });
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith(".md")) continue;
      const dest = join(destDir, f);
      const body = readFileSync(join(srcDir, f), "utf8") + `\n<!-- ${MARKER} -->\n`;
      if (existsSync(dest)) {
        const current = readFileSync(dest, "utf8");
        if (!current.includes(MARKER)) continue;
        if (current === body) continue;
      }
      const tmp = `${dest}.${process.pid}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, dest);
    }
  }
} catch {}

try {
  const args = single ? ["shims-heal"] : [join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin", "tkr.js"), "shims-heal"];
  const healed = spawnSync(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 3000, windowsHide: true });
  if (healed.status === 0 && healed.stdout && healed.stdout.trim()) context = healed.stdout.trim();
} catch {}

try {
  const SEMVER = /^\d+\.\d+\.\d+$/;
  const self = basename(pluginRoot);
  if (SEMVER.test(self)) {
    const parent = dirname(pluginRoot);
    const bySemver = (a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    };
    const others = readdirSync(parent)
      .filter((n) => SEMVER.test(n) && n !== self)
      .filter((n) => statSync(join(parent, n)).isDirectory())
      .sort(bySemver);
    const keepNewest = others.length ? others[others.length - 1] : null;
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    for (const n of others) {
      if (n === keepNewest) continue;
      const p = join(parent, n);
      if (statSync(p).mtimeMs > cutoff) continue;
      rmSync(p, { recursive: true, force: true });
    }
  }
} catch {}

try {
  const onboardFile = join(home, "onboarded");
  if (!existsSync(onboardFile)) {
    userMessages.push(
      "Tokmizer is on with the recommended settings. Free tier, no account needed.\n" +
        "See it live anytime: /tkr-status. Your savings: /tkr-gain.\n" +
        "Tune it with /tkr. Paid plan? Link it with /tkr-link."
    );
    mkdirSync(home, { recursive: true });
    writeFileSync(onboardFile, String(Date.now()));
  }
} catch {}

try {
  const noticeFile = join(home, "network-notice-shown");
  if (!networkOff && !existsSync(noticeFile)) {
    userMessages.push(
      [
        "Tokmizer contacts tokmizer.com to keep its rules up to date and to improve the product. No account or email is needed.",
        "It sends a random install ID, your computer name, OS and CPU model, a hash of your network card address and of your user name, and the plugin version. Command contents and output are never sent.",
        "Usage stats (command names, token counts and install health counts) are sent only while they are on. Check with: tkr telemetry status.",
        "Turn all network access off: tkr network off. Usage stats only: tkr telemetry off."
      ].join("\n")
    );
    mkdirSync(home, { recursive: true });
    writeFileSync(noticeFile, String(Date.now()));
  }
} catch {}

try {
  const onboardFile = join(home, "onboarded");
  const nudgeFile = join(home, "value-nudge");
  if (existsSync(onboardFile) && !existsSync(nudgeFile)) {
    const onboardedAt = Number(readFileSync(onboardFile, "utf8")) || 0;
    if (onboardedAt > 0 && existsSync(join(home, "stats.jsonl"))) {
      let rawB = 0;
      let filtB = 0;
      for (const line of readFileSync(join(home, "stats.jsonl"), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (typeof rec.r === "number" && typeof rec.f === "number") {
            rawB += rec.r;
            filtB += rec.f;
          }
        } catch {}
      }
      const saved = Math.max(0, Math.ceil(rawB / 4) - Math.ceil(filtB / 4));
      if (saved >= 1000) {
        const label = saved >= 1e6 ? (saved / 1e6).toFixed(1) + "M" : saved >= 1e3 ? (saved / 1e3).toFixed(1) + "K" : String(saved);
        userMessages.push(`Tokmizer has already saved you ~${label} tokens since install. Details: /tkr-gain`);
        writeFileSync(nudgeFile, String(Date.now()));
      }
    }
  }
} catch {}

try {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  const latest = state.latestPluginVersion;
  if (latest && manifest.version && latest !== manifest.version) {
    const nudgeFile = join(home, `update-nudge-${latest}`);
    if (!existsSync(nudgeFile)) {
      const claudeDir = join(homedir(), ".claude");
      const fromCatalog = /[\\/]plugins[\\/]cache[\\/]tokmizer[\\/]/.test(pluginRoot) && (process.env.CLAUDE_CONFIG_DIR || claudeDir) === claudeDir;
      let autoOn = false;
      try {
        autoOn = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"))?.extraKnownMarketplaces?.tokmizer?.autoUpdate === true;
      } catch {}
      userMessages.push(fromCatalog && !autoOn
        ? `Tokmizer ${latest} is available. Run /tkr-update once: it updates now and turns on automatic updates.`
        : `Tokmizer ${latest} is available. Update with: /tkr-update`);
      writeFileSync(nudgeFile, String(Date.now()));
    }
  }
} catch {}

try {
  const stateFile = join(home, "state.json");
  const throttleFile = join(home, "last-auto-heartbeat");
  const THROTTLE_MS = 6 * 60 * 60 * 1000;

  let last = 0;
  try {
    last = Number(readFileSync(throttleFile, "utf8")) || 0;
  } catch {}

  if (!networkOff && existsSync(stateFile) && Date.now() - last >= THROTTLE_MS) {
    try {
      writeFileSync(throttleFile, String(Date.now()));
    } catch {}
    const args = single ? ["heartbeat"] : [join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin", "tkr.js"), "heartbeat"];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  }
} catch {}

if (userMessages.length) {
  console.log(JSON.stringify({
    systemMessage: userMessages.join("\n\n"),
    ...(context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } : {})
  }));
} else if (context) {
  console.log(context);
}

await drained;
process.stdin.destroy();
