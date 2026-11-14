import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tsImport } from "tsx/esm/api";

export const releaseDefines = { "process.env.TOKMIZER_RELEASE_BUILD": '"1"' };

export async function bundleDefines(directory) {
  const { buildDefaultRules } = await tsImport("../src/default-rules-build.ts", import.meta.url);
  const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
  return {
    ...releaseDefines,
    "process.env.TOKMIZER_DEFAULT_RULES": JSON.stringify(await buildDefaultRules()),
    "process.env.TOKMIZER_BUILD_VERSION": JSON.stringify(version)
  };
}

export const singleBanner = 'import { createRequire as __tkrCreateRequire } from "node:module"; import { realpathSync as __tkrRealpath } from "node:fs"; import { pathToFileURL as __tkrPathToFileURL } from "node:url"; const __tkrSelfUrl = __tkrPathToFileURL(__tkrRealpath(process.execPath)).href; const require = __tkrCreateRequire(__tkrSelfUrl);';

function files(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => (name === "__tests__" ? [] : files(join(path, name))));
}

export function sourceFingerprint(directory) {
  const hash = createHash("sha256");
  const inputs = ["src", "filters", "hooks/on-session-start.mjs", "package.json", "../../package-lock.json", "scripts/bundle-config.mjs"]
    .flatMap((entry) => files(join(directory, entry)))
    .sort();
  for (const file of inputs) {
    const content = file.endsWith("package-lock.json") ? lockWithoutPlatformPins(readFileSync(file, "utf8")) : readFileSync(file);
    hash.update(relative(directory, file).split(sep).join("/")).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

const PLATFORM_ENTRY = /(?:^|\/)node_modules\/@tokmizer\/plugin-[^/]+$/;

export function lockWithoutPlatformPins(text) {
  const lock = JSON.parse(text);
  for (const name of Object.keys(lock.packages ?? {})) {
    if (PLATFORM_ENTRY.test(name)) delete lock.packages[name];
  }
  const plugin = lock.packages?.["packages/plugin"];
  if (plugin) {
    delete plugin.version;
    for (const name of Object.keys(plugin.optionalDependencies ?? {})) {
      if (name.startsWith("@tokmizer/plugin-")) delete plugin.optionalDependencies[name];
    }
  }
  return JSON.stringify(lock);
}
