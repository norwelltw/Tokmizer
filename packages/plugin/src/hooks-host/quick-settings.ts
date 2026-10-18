import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokmizerHome } from "../paths";
import { failOpenActive } from "../shim/sh";

export function reducerConfigured(): boolean {
  try {
    const s = JSON.parse(readFileSync(join(tokmizerHome(), "settings-cache.json"), "utf8")) as {
      enabled?: unknown;
      reducer?: unknown;
    };
    return s.enabled !== false && typeof s.reducer === "string" && s.reducer !== "off";
  } catch {
    return false;
  }
}

export function tokmizerEnabled(): boolean {
  if (failOpenActive()) return false;
  try {
    const s = JSON.parse(readFileSync(join(tokmizerHome(), "settings-cache.json"), "utf8")) as { enabled?: unknown };
    return s.enabled !== false;
  } catch {
    return true;
  }
}
