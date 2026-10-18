import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const forbidden = process.env.TOKMIZER_TEST_FORBIDDEN_HOME;
const violations = process.env.TOKMIZER_TEST_VIOLATIONS;
const marker = Symbol.for("tokmizer.test.home-guard");

function asPath(value) {
  if (typeof value === "string") return value;
  if (value instanceof URL && value.protocol === "file:") return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function forbiddenPath(value) {
  const path = asPath(value);
  if (!path || !forbidden) return null;
  const absolute = resolve(path);
  return absolute === forbidden || absolute.startsWith(`${forbidden}/`) || absolute.startsWith(`${forbidden}\\`) ? absolute : null;
}

const appendRaw = fs.appendFileSync;

function report(name, path) {
  if (!violations) return;
  try {
    appendRaw(violations, `${name} ${path} pid=${process.pid} argv=${process.argv.slice(1).join(" ")}\n`);
  } catch {}
}

function denied(name, path) {
  report(name, path);
  const error = new Error(`test touched the real Tokmizer home: ${name} ${path}`);
  error.code = "EACCES";
  return error;
}

function guardSync(target, name, pathArgs = [0], quiet = undefined) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function guarded(...args) {
    for (const index of pathArgs) {
      const hit = forbiddenPath(args[index]);
      if (!hit) continue;
      if (quiet !== undefined) {
        report(name, hit);
        return quiet;
      }
      throw denied(name, hit);
    }
    return original.apply(this, args);
  };
}

function guardCallback(target, name, pathArgs = [0]) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function guarded(...args) {
    for (const index of pathArgs) {
      const hit = forbiddenPath(args[index]);
      if (!hit) continue;
      const error = denied(name, hit);
      const callback = args.findLast((arg) => typeof arg === "function");
      if (callback) {
        process.nextTick(() => callback(error));
        return undefined;
      }
      throw error;
    }
    return original.apply(this, args);
  };
}

function guardPromise(target, name, pathArgs = [0]) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function guarded(...args) {
    for (const index of pathArgs) {
      const hit = forbiddenPath(args[index]);
      if (hit) return Promise.reject(denied(name, hit));
    }
    return original.apply(this, args);
  };
}

if (forbidden && !globalThis[marker]) {
  globalThis[marker] = true;
  const single = ["readFileSync", "writeFileSync", "appendFileSync", "mkdirSync", "openSync", "readdirSync", "statSync", "lstatSync", "rmSync", "unlinkSync", "rmdirSync", "chmodSync", "realpathSync", "createReadStream", "createWriteStream", "mkdtempSync", "accessSync", "utimesSync", "truncateSync", "symlinkSync"];
  const pairs = ["renameSync", "copyFileSync", "linkSync", "cpSync"];
  const callbacks = ["readFile", "writeFile", "appendFile", "mkdir", "open", "readdir", "stat", "lstat", "rm", "unlink", "rmdir", "chmod", "access", "utimes", "truncate", "mkdtemp", "realpath"];
  for (const name of single) guardSync(fs, name);
  for (const name of pairs) guardSync(fs, name, [0, 1]);
  guardSync(fs, "existsSync", [0], false);
  for (const name of callbacks) guardCallback(fs, name);
  for (const name of ["rename", "copyFile", "link", "cp"]) guardCallback(fs, name, [0, 1]);
  for (const name of callbacks) guardPromise(fs.promises, name);
  for (const name of ["rename", "copyFile", "link", "cp"]) guardPromise(fs.promises, name, [0, 1]);
  syncBuiltinESMExports();
  const realFetch = globalThis.fetch;
  if (typeof realFetch === "function") {
    globalThis.fetch = function guardedFetch(input, init) {
      let host = "";
      try {
        host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname;
      } catch {}
      if (host === "tokmizer.com" || host.endsWith(".tokmizer.com")) {
        report("fetch", host);
        return Promise.reject(new Error(`test reached the production server: ${host}`));
      }
      return realFetch.call(this, input, init);
    };
  }
}
