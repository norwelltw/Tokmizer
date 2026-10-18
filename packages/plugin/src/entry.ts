import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

let selected: string | null = null;

export function selectSingleEntry(name: string): void {
  selected = name;
}

export function isEntryModule(entry: string, moduleUrl: string, name?: string): boolean {
  if (name !== undefined && selected === name) return true;
  if (selected !== null || !entry) return false;
  if (moduleUrl === pathToFileURL(entry).href) return true;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
