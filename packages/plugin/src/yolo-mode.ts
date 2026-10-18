import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tokmizerHome } from "./paths";

export function yoloEnabled(): boolean {
  try {
    return readFileSync(join(tokmizerHome(), "yolo-mode"), "utf8") === "on";
  } catch {
    return false;
  }
}

export async function setYoloMode(enabled: boolean): Promise<void> {
  const home = tokmizerHome();
  const path = join(home, "yolo-mode");
  if (!enabled) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, "on", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
