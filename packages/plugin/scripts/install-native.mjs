import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionStartCommand = '"${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec" --session-start';
const windowsCommand = "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr-exec.exe";

function sessionStartHook(hook) {
  return hook.command === sessionStartCommand || (hook.command === windowsCommand && Array.isArray(hook.args) && hook.args.length === 1 && hook.args[0] === "--session-start");
}

function configureSessionStart(manifest, mode) {
  const groups = manifest.hooks?.SessionStart;
  if (!Array.isArray(groups) || groups.length === 0) return false;
  const wanted = mode === "windows" ? { type: "command", command: windowsCommand, args: ["--session-start"], timeout: 5 } : mode === "unix" ? { type: "command", command: sessionStartCommand, timeout: 5 } : null;
  const present = groups.flatMap((group) => (group.hooks ?? []).filter(sessionStartHook));
  if (wanted && present.length === 1 && present[0].command === wanted.command) return false;
  if (!wanted && present.length === 0) return false;
  for (const group of groups) if (group.hooks) group.hooks = group.hooks.filter((hook) => !sessionStartHook(hook));
  if (wanted) (groups[0].hooks ??= []).unshift(wanted);
  return true;
}

const root = "${CLAUDE_PLUGIN_ROOT}";
const knownHooks = [
  { event: "PreToolUse", node: `node "${root}/dist/hooks-host/pre-tool-use.js"`, words: ["hook", "pre-tool-use"], flag: "--pre-tool-use" },
  { event: "PostToolUse", node: `node "${root}/dist/hooks-host/post-tool-use.js"`, words: ["hook", "post-tool-use"], flag: "--post-tool-use" },
  { event: "SessionStart", node: `node "${root}/hooks/on-session-start.mjs"`, words: ["hook", "session-start"] },
  { event: "SessionStart", node: `node "${root}/dist/hooks-host/reducer-session-start.js"`, words: ["hook", "reducer-session-start"] },
  { event: "SessionStart", node: `node "${root}/dist/hooks-host/session-recap.js"`, words: ["hook", "session-recap"] },
  { event: "UserPromptSubmit", node: `node "${root}/dist/hooks-host/reducer-prompt-submit.js"`, words: ["hook", "reducer-prompt-submit"] },
  { event: "Stop", node: `node "${root}/dist/hooks-host/reducer-stop.js"`, words: ["hook", "reducer-stop"] }
];

function hookForms(spec) {
  const forms = {
    node: { command: spec.node },
    singleUnix: { command: `"${root}/dist/bin/tkr" ${spec.words.join(" ")}` },
    singleWindows: { command: `${root}/dist/bin/tkr.exe`, args: spec.words }
  };
  if (spec.flag) {
    forms.nativeUnix = { command: `"${root}/dist/bin/tkr-exec" ${spec.flag}` };
    forms.nativeWindows = { command: windowsCommand, args: [spec.flag] };
  }
  return forms;
}

function sameArgs(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function matchesForm(hook, form) {
  return hook.command === form.command && (!form.args || sameArgs(hook.args, form.args));
}

function wantedForm(forms, mode, single, windows) {
  if (forms.nativeUnix && mode === "unix") return forms.nativeUnix;
  if (forms.nativeWindows && mode === "windows") return forms.nativeWindows;
  if (single) return windows ? forms.singleWindows : forms.singleUnix;
  return forms.node;
}

function configureHook(directory, mode, single = false, windows = mode === "windows") {
  const path = join(directory, "hooks", "hooks.json");
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, "utf8")); } catch { return; }
  const before = JSON.stringify(manifest);
  configureSessionStart(manifest, mode);
  for (const spec of knownHooks) {
    const forms = hookForms(spec);
    const wanted = wantedForm(forms, mode, single, windows);
    for (const group of manifest.hooks?.[spec.event] ?? []) {
      for (const hook of group.hooks ?? []) {
        if (!Object.values(forms).some((form) => matchesForm(hook, form))) continue;
        hook.command = wanted.command;
        if (wanted.args) hook.args = [...wanted.args];
        else delete hook.args;
      }
    }
  }
  if (JSON.stringify(manifest) === before) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function singlePath(directory, platform) {
  return join(directory, "dist", "bin", platform === "win32" ? "tkr.exe" : "tkr");
}

function probeSingle(path, version) {
  try {
    return execFileSync(path, ["--single-check"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() === `tokmizer-single ${version}`;
  } catch {
    return false;
  }
}

function packageVersion(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
}

export function singleInstalled(directory = packageDirectory, platform = process.platform) {
  if (process.env.TOKMIZER_SINGLE_EXEC === "0") return false;
  const path = singlePath(directory, platform);
  try {
    return existsSync(path) && probeSingle(path, packageVersion(directory));
  } catch {
    return false;
  }
}

export function installSingle(directory = packageDirectory, platform = process.platform, arch = process.arch) {
  const target = singlePath(directory, platform);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const discard = () => {
    try { rmSync(target, { force: true }); } catch {}
    return false;
  };
  try {
    if (process.env.TOKMIZER_SINGLE_EXEC === "0" || !["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) return discard();
    const version = packageVersion(directory);
    const key = `${platform}-${arch}`;
    const entry = JSON.parse(readFileSync(join(directory, "dist", "native", "single.json"), "utf8"))[key];
    if (!entry || entry.version !== version || entry.package !== `@tokmizer/plugin-${key}` || entry.file !== (platform === "win32" ? "tkr.exe" : "tkr") || !/^[0-9a-f]{64}$/.test(entry.sha256)) return discard();
    const source = join(dirname(createRequire(join(directory, "package.json")).resolve(`${entry.package}/package.json`)), entry.file);
    const bytes = readFileSync(source);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return discard();
    try { chmodSync(source, 0o755); } catch {}
    if (!probeSingle(source, version)) return discard();
    try {
      linkSync(source, temporary);
    } catch {
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o755 });
    }
    chmodSync(temporary, 0o755);
    if (createHash("sha256").update(readFileSync(temporary)).digest("hex") !== entry.sha256) return discard();
    renameSync(temporary, target);
    return probeSingle(target, version) || discard();
  } catch {
    return discard();
  } finally {
    try { rmSync(temporary, { force: true }); } catch {}
  }
}

export function installNative(directory = packageDirectory, platform = process.platform, arch = process.arch, single = singleInstalled(directory, platform)) {
  const windows = platform === "win32";
  const launcher = join(directory, "dist", "bin", "tkr-exec");
  const target = windows ? `${launcher}.exe` : launcher;
  const temporaries = [];
  const replace = (destination, bytes) => {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    temporaries.push(temporary);
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o755 });
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  };
  try {
    configureHook(directory, "node", single, windows);
    replace(launcher, readFileSync(join(directory, "dist", "bin", "tkr-exec.js")));
    if (windows) rmSync(target, { force: true });
    if (process.env.TOKMIZER_NATIVE_EXEC === "0" || !["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) return false;
    const { version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(directory, "dist", "native", "manifest.json"), "utf8"));
    const key = `${platform}-${arch}`;
    const entry = manifest[key];
    if (!entry || entry.version !== version || entry.file !== `tkr-exec-${key}${windows ? ".exe" : ""}` || !/^[0-9a-f]{64}$/.test(entry.sha256)) return false;
    const source = join(directory, "dist", "native", entry.file);
    const bytes = readFileSync(source);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return false;
    chmodSync(source, 0o755);
    const probe = (path) => execFileSync(path, ["--native-check"], { encoding: "utf8", timeout: 2000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() === `tokmizer-native ${version} protocol=2`;
    if (!probe(source)) return false;
    replace(target, bytes);
    let installed = false;
    try { installed = probe(target); } catch {}
    if (!installed) {
      if (windows) rmSync(target, { force: true });
      else replace(launcher, readFileSync(join(directory, "dist", "bin", "tkr-exec.js")));
      return false;
    }
    configureHook(directory, windows ? "windows" : "unix", single, windows);
    return true;
  } catch {
    return false;
  } finally {
    for (const temporary of temporaries) {
      try { rmSync(temporary, { force: true }); } catch {}
    }
  }
}

export function healShims(directory = packageDirectory) {
  if (process.env.TOKMIZER_POSTINSTALL_HEAL === "0" || !directory.split(/[\\/]/).includes("node_modules")) return false;
  const entry = join(directory, "dist", "bin", "tkr.js");
  if (!existsSync(entry)) return false;
  try {
    execFileSync(process.execPath, [entry, "shims-heal"], { stdio: "ignore", timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--native-only")) {
    installNative();
  } else {
    installSingle();
    installNative();
    healShims();
  }
}
