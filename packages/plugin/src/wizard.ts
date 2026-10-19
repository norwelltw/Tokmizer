import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import os from "node:os";
import { join } from "node:path";
import { M } from "./ui";
import { activate } from "./license";
import { loadState } from "./state";
import { runConfigure } from "./configure";
import { installShims, resolveShimJsPath, ensurePathInRc, shellRcLine } from "./shim/install";

export async function runWizard(baseUrl: string): Promise<void> {
  const existing = await loadState();
  if (existing) {
    stdout.write(M.activated + "\n");
    return;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let activated = false;
  try {
    stdout.write(`${M.welcome}\n${M.needToken}\n${M.getToken}\n\n`);
    const token = (await rl.question(`${M.askToken} `)).trim();
    stdout.write(`${M.activating}\n`);
    await activate({ token, baseUrl });
    stdout.write(M.activated + "\n");
    activated = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stdout.write(`${msg}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
  if (activated) {
    await runConfigure();
    await finishSetup();
  }
}

async function finishSetup(): Promise<void> {
  try {
    if (stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        const ans = (await rl.question("Also optimize your commands outside the agent (terminal)? [y/N] "))
          .trim()
          .toLowerCase();
        if (ans === "y" || ans === "yes") {
          const created = await installShims(resolveShimJsPath());
          stdout.write(`Installed ${created.length} shims.\n`);
          const rc = join(os.homedir(), (process.env.SHELL ?? "").includes("zsh") ? ".zshrc" : ".bashrc");
          const r = await ensurePathInRc(rc);
          if (r === "added") stdout.write(`Added PATH to ${rc}. Open a new terminal.\n`);
          else if (r === "missing") stdout.write(`Add this to your shell rc:\n${shellRcLine()}`);
        }
      } finally {
        rl.close();
      }
    }
  } catch {}

  try {
    const { connectDaemon } = await import("./daemon/client");
    const client = await connectDaemon();
    await client.ping();
    client.close();
    stdout.write("  Engine: ✅ active\n");
  } catch {
    stdout.write("  Engine: starts on first use\n");
  }

  stdout.write(
    "\n✅ Ready. tokmizer optimizes your commands automatically.\n" +
      "   Run \"tkr gain\" anytime to see your savings.\n"
  );
}
