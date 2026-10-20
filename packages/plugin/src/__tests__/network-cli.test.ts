import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

const cli = resolve("packages/plugin/src/bin/tkr.ts");
const requests: string[] = [];
let server: Server;
let baseUrl: string;
let home: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = 503;
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  requests.length = 0;
  home = mkdtempSync(join(tmpdir(), "tkr-network-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10 });
});

function seedState(): string {
  const raw = JSON.stringify({
    token: "tokmizer_cli_net", jwt: "cli-net-jwt", signingSecret: "cli-net-secret",
    plan: "pro", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1,
    installId: "cli-net-install", linked: true, email: "user@example.com", lastHeartbeatOkAt: Date.now()
  });
  writeFileSync(join(home, "state.json"), raw);
  return raw;
}

function run(args: string[], extra: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
      env: {
        ...process.env,
        CI: "",
        GITHUB_ACTIONS: "",
        TOKMIZER_NETWORK: "",
        TOKMIZER_HOME: home,
        TOKMIZER_BASE_URL: baseUrl,
        TOKMIZER_DAEMON_BIN: join(home, "disabled-daemon.js"),
        TOKMIZER_CLAUDE_COMMANDS_DIR: join(home, "commands"),
        XDG_RUNTIME_DIR: "",
        ...extra
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

describe("tkr network", () => {
  it("turns the network off, reports it everywhere and sends nothing", async () => {
    const raw = seedState();
    const off = await run(["network", "off"]);
    expect(off.status).toBe(0);
    expect(off.stdout).toContain("Network: off");
    expect(off.stdout).toContain("tkr network on");
    expect(existsSync(join(home, "network-off"))).toBe(true);

    expect((await run(["network"])).stdout).toContain("Network: off");
    const status = await run(["status"]);
    expect(status.stdout).toContain("Network: off");
    expect(status.stdout).not.toContain("Tokmizer contacts tokmizer.com");
    expect((await run(["doctor"])).stdout).toMatch(/Network: +off/);

    const link = await run(["link", "tokmizer_somekey"]);
    expect(link.status).toBe(1);
    expect(link.stdout).toContain("tkr network on");
    const hb = await run(["heartbeat"]);
    expect(hb.status).toBe(1);
    expect(hb.stderr).toContain("tkr network on");

    expect((await run(["telemetry", "on"])).stdout).toContain("nothing is sent");
    expect((await run(["compression", "max"])).status).toBe(0);
    expect((await run(["settings", "show"])).stdout).toContain('"outputVerbosity": "minimal"');
    await run(["reducer", "light"]);
    await run(["gain"]);
    await run(["self-update"]);

    expect(readFileSync(join(home, "state.json"), "utf8")).toBe(raw);
    expect(requests).toEqual([]);

    const unlink = await run(["unlink"]);
    expect(unlink.stdout).toContain("tokmizer.com was not told");
    expect(requests).toEqual([]);
  }, 60000);

  it("never enrolls a fresh install while TOKMIZER_NETWORK=0", async () => {
    const env = { TOKMIZER_NETWORK: "0" };
    const status = await run(["status"], env);
    expect(status.stdout).toContain("Network: off (TOKMIZER_NETWORK)");
    expect(status.stdout).toContain("Nothing is sent while network is off");
    expect((await run(["network", "on"], env)).stdout).toContain("TOKMIZER_NETWORK still blocks it");
    await run(["settings", "set", "reducer", "off"], env);
    await run(["telemetry", "status"], env);
    expect(requests).toEqual([]);
    for (const file of ["state.json", "install-id", "enroll-cooldown"]) expect(existsSync(join(home, file))).toBe(false);
  }, 30000);

  it("restores the previous behaviour once turned back on", async () => {
    seedState();
    await run(["network", "off"]);
    const on = await run(["network", "on"]);
    expect(on.stdout).toContain("Network: on");
    expect(existsSync(join(home, "network-off"))).toBe(false);
    await run(["heartbeat"]);
    expect(requests).toContain("POST /api/v1/license/heartbeat");
  }, 30000);

  it("shows the network notice once on a fresh online install", async () => {
    const first = await run(["status"]);
    expect(first.stdout).toContain("Tokmizer contacts tokmizer.com to keep its rules up to date");
    const second = await run(["status"]);
    expect(second.stdout).not.toContain("Tokmizer contacts tokmizer.com");
  }, 30000);
});

describe("Claude Code session hook", () => {
  const runHook = (extra: Record<string, string> = {}, heal = "") => new Promise<string>((done) => {
    const root = join(home, "plugin");
    mkdirSync(join(root, "hooks"), { recursive: true });
    mkdirSync(join(root, "dist", "bin"), { recursive: true });
    copyFileSync(resolve("packages/plugin/hooks/on-session-start.mjs"), join(root, "hooks", "on-session-start.mjs"));
    writeFileSync(join(root, "dist", "bin", "tkr.js"), `if (process.argv[2] !== "shims-heal") require("node:fs").writeFileSync(${JSON.stringify(join(home, "heartbeat-spawned"))}, process.argv.slice(2).join(" ")); else process.stdout.write(${JSON.stringify(heal)});\n`);
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "commonjs" }));
    const child = spawn(process.execPath, [join(root, "hooks", "on-session-start.mjs")], {
      env: { ...process.env, TOKMIZER_HOME: home, TOKMIZER_NETWORK: "", TOKMIZER_CLAUDE_COMMANDS_DIR: join(home, "commands"), CLAUDE_PLUGIN_ROOT: join(home, "no-plugin"), ...extra },
      stdio: ["ignore", "pipe", "ignore"]
    });
    let out = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.on("close", () => done(out));
  });

  const spawned = async (): Promise<string | null> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(join(home, "heartbeat-spawned"))) return readFileSync(join(home, "heartbeat-spawned"), "utf8");
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };

  it("does not start a heartbeat and shows no notice while network is off", async () => {
    seedState();
    writeFileSync(join(home, "network-off"), "1");
    const out = await runHook();
    expect(out).not.toContain("Tokmizer contacts tokmizer.com");
    expect(existsSync(join(home, "last-auto-heartbeat"))).toBe(false);
    expect(existsSync(join(home, "network-notice-shown"))).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(home, "heartbeat-spawned"))).toBe(false);
  });

  it("shows the notice once and keeps the heartbeat when network is on", async () => {
    seedState();
    expect(await runHook({ TOKMIZER_NETWORK: "1" })).toContain("Tokmizer contacts tokmizer.com");
    expect(await spawned()).toBe("heartbeat");
    expect(await runHook()).not.toContain("Tokmizer contacts tokmizer.com");
  });

  const onlyJson = (out: string) => {
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as { systemMessage?: string; hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
  };

  const quietStart = () => {
    writeFileSync(join(home, "onboarded"), String(Date.now() - 1000));
    writeFileSync(join(home, "network-notice-shown"), "1");
  };

  it("shows the first-run and network notices to the user in one system message", async () => {
    const out = onlyJson(await runHook({ TOKMIZER_NETWORK: "1" }));
    expect(out.systemMessage).toContain("Tokmizer is on with the recommended settings.");
    expect(out.systemMessage).toContain("Tokmizer contacts tokmizer.com to keep its rules up to date");
    expect(out.systemMessage).toContain("Turn all network access off: tkr network off.");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("shows the savings nudge to the user", async () => {
    quietStart();
    writeFileSync(join(home, "stats.jsonl"), `${JSON.stringify({ r: 8000, f: 0 })}\n`);
    expect(onlyJson(await runHook()).systemMessage).toBe("Tokmizer has already saved you ~2.0K tokens since install. Details: /tkr-gain");
  });

  it("shows the update nudge to the user", async () => {
    quietStart();
    mkdirSync(join(home, "no-plugin", ".claude-plugin"), { recursive: true });
    writeFileSync(join(home, "no-plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.0.1" }));
    writeFileSync(join(home, "state.json"), JSON.stringify({ latestPluginVersion: "9.9.9" }));
    writeFileSync(join(home, "last-auto-heartbeat"), String(Date.now()));
    expect(onlyJson(await runHook()).systemMessage).toBe("Tokmizer 9.9.9 is available. Update with: /tkr-update");
  });

  it("keeps repair output as agent context next to a user message", async () => {
    const out = onlyJson(await runHook({}, "Repaired the codex hook.\n"));
    expect(out.systemMessage).toContain("Tokmizer is on with the recommended settings.");
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: "Repaired the codex hook." });
  });

  it("keeps repair output as plain context when there is no user message", async () => {
    quietStart();
    expect(await runHook({}, "Repaired the codex hook.\n")).toBe("Repaired the codex hook.\n");
  });

  it("prints nothing when no message applies", async () => {
    quietStart();
    expect(await runHook()).toBe("");
  });
});
