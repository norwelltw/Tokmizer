import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { socketPath } from "../daemon/lifecycle";
import type { DaemonRuntime } from "../daemon/runtime";
import { tokmizerHome } from "../paths";
import { PLUGIN_VERSION } from "../version";
import { startProcessingServer } from "./processing-server";

export function processorDescriptorName(version = PLUGIN_VERSION): string {
  return `processing-${version}.json`;
}

export function processingPipeName(user: string, version: string, nonce: string): string {
  const account = user.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "user";
  return `\\\\.\\pipe\\tokmizer-p-${account}-${version.replace(/[^A-Za-z0-9._-]/g, "_")}-${nonce}`;
}

export async function startProcessingEndpoint(
  getRuntime: () => DaemonRuntime | null,
  onActivity?: () => void,
  descriptorName = "processing.json"
): Promise<Awaited<ReturnType<typeof startProcessingServer>> | null> {
  const windows = process.platform === "win32";
  const home = realpathSync(tokmizerHome());
  const run = join(home, "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const directory = lstatSync(run);
  if (!directory.isDirectory() || (!windows && (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0))) {
    throw new Error("unsafe processing descriptor directory");
  }
  const nonce = randomUUID().slice(0, 8);
  const path = windows
    ? processingPipeName(process.env.USERNAME ?? "user", PLUGIN_VERSION, nonce)
    : join(dirname(socketPath().path), `p${nonce}`);
  if (!windows && Buffer.byteLength(path) > 100) throw new Error("processing socket path too long");
  const token = randomBytes(32).toString("hex");
  const server = await startProcessingServer({ path, token, version: PLUGIN_VERSION, getRuntime, ...(onActivity ? { onActivity } : {}) });
  const temporary = join(run, `${descriptorName}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ protocol: 2, version: PLUGIN_VERSION, home, path, token }), { mode: 0o600, flag: "wx" });
    renameSync(temporary, join(run, descriptorName));
    return server;
  } catch (error) {
    await server.close();
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}
