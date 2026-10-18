import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let dir: string;
const cliPath = resolve("packages/plugin/src/bin/tkr.ts");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-yolo-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
    input: "",
    timeout: 10000,
    env: {
      ...process.env,
      CI: "0",
      GITHUB_ACTIONS: "",
      TOKMIZER_HOME: dir,
      TOKMIZER_BASE_URL: "http://127.0.0.1:1",
      TOKMIZER_AUTO_UPDATE: "0",
      TOKMIZER_DAEMON_BIN: join(dir, "disabled-daemon.js"),
      TOKMIZER_CLAUDE_COMMANDS_DIR: join(dir, "commands"),
      XDG_RUNTIME_DIR: ""
    }
  });
}

async function runWithSettings(args: string[], answers: string[] = [], serverStatus = 200) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const requests: { method: string | undefined; url: string | undefined; body: unknown }[] = [];
  const settings = {
    enabled: true,
    telemetryOptIn: false,
    outputVerbosity: "compact",
    reducer: "off",
    filters: { enableAll: true, disabled: [] }
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    token: "tokmizer_yolo_test",
    jwt: "yolo-test-jwt",
    signingSecret: "yolo-test-signing-secret",
    plan: "pro",
    status: "active",
    trialEndsAt: null,
    subEndsAt: null,
    jwtVersion: 1,
    installId: "yolo-test-install",
    linked: true,
    lastHeartbeatOkAt: Date.now()
  }));
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, url: req.url, body });
    if (serverStatus !== 200) {
      res.writeHead(serverStatus, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const response = JSON.stringify({ plan: "pro", settings: { ...settings, ...body } });
    const timestamp = Date.now();
    res.writeHead(200, {
      "content-type": "application/json",
      "x-tokmizer-resp-ts": String(timestamp),
      "x-tokmizer-resp-sig": sign(null, Buffer.from(`${timestamp}.${response}`), privateKey).toString("base64url")
    });
    res.end(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
        timeout: 10000,
        env: {
          ...process.env,
          CI: "1",
          TOKMIZER_HOME: dir,
          TOKMIZER_BASE_URL: `http://127.0.0.1:${address.port}`,
          TOKMIZER_AUTO_UPDATE: "0",
          TOKMIZER_DAEMON_BIN: join(dir, "disabled-daemon.js"),
          TOKMIZER_CLAUDE_COMMANDS_DIR: join(dir, "commands"),
          TOKMIZER_DEV: "1",
          TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
          XDG_RUNTIME_DIR: ""
        }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.endsWith(": ") && answers.length) child.stdin.write(`${answers.shift()}\n`);
      });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { ...result, requests };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("local YOLO commands", () => {
  it("reports the default off mode without activating or creating local state", () => {
    for (const args of [["yolo"], ["yolo", "status"]]) {
      const result = run(...args);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("YOLO: off (this machine only)");
      expect(result.stderr).toBe("");
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("enables and disables offline with an explicit warning and no activation side effects", () => {
    const enabled = run("yolo", "on");
    expect(enabled.status).toBe(0);
    expect(enabled.stdout).toContain("YOLO: on (this machine only)");
    expect(enabled.stderr).toMatch(/content and diagnostics.*lost/i);
    expect(enabled.stderr).toContain("cannot be restored");
    expect(enabled.stderr).toContain("exit codes");
    expect(readFileSync(join(dir, "yolo-mode"), "utf8")).toBe("on");
    expect(readdirSync(dir)).toEqual(["yolo-mode"]);
    expect(run("yolo", "status").stdout).toContain("YOLO: on");

    const disabled = run("yolo", "off");
    expect(disabled.status).toBe(0);
    expect(disabled.stdout).toContain("YOLO: off (this machine only)");
    expect(disabled.stderr).toBe("");
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ["unknown"], ["--yes"], ["on", "extra"], ["off", "extra"], ["status", "extra"]
  ])("rejects malformed arguments %j without changing the mode", (...args) => {
    writeFileSync(join(dir, "yolo-mode"), "on");
    const result = run("yolo", ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: tkr yolo [on|off|status]");
    expect(result.stdout).toBe("");
    expect(readFileSync(join(dir, "yolo-mode"), "utf8")).toBe("on");
    expect(readdirSync(dir)).toEqual(["yolo-mode"]);
  });

  it("shows the effective compression and local mode without cached activation", () => {
    writeFileSync(join(dir, "yolo-mode"), "on");
    const compression = run("compression");
    expect(compression.status).toBe(0);
    expect(compression.stdout).toContain("Compression: YOLO");
    expect(compression.stdout).toContain("Standard level: balanced");
    expect(compression.stdout).not.toContain("errors always stay");
    expect(run("status").stdout).toContain("YOLO: on (this machine only)");
    expect(run("settings", "show").stdout).toContain("YOLO: on (this machine only)");
    expect(run("help").stdout).toContain("yolo [on|off|status]");
  });

  it("still reports the local mode when settings activation cannot access its home", () => {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not a directory");
    const result = run("settings", "show");
    expect(result.stdout).toContain("YOLO: off (this machine only)");
  });

  it.each(["light", "balanced", "max"])("leaves YOLO and keeps the standard level %s on this machine while the install cannot enroll", (level) => {
    writeFileSync(join(dir, "yolo-mode"), "on");
    const result = run("compression", level);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("YOLO: off (this machine only)");
    expect(result.stdout).toContain(`Compression set to ${level}.`);
    expect(result.stdout + result.stderr).not.toContain("Not activated");
    expect(existsSync(join(dir, "yolo-mode"))).toBe(false);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
    expect(run("compression").stdout).toContain(`Compression: ${level}`);
  });

  it.each(["light", "balanced", "max"])("leaves YOLO before a standard level %s update the server rejects", async (level) => {
    writeFileSync(join(dir, "yolo-mode"), "on");
    const result = await runWithSettings(["compression", level], [], 500);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("YOLO: off (this machine only)");
    expect(result.stdout + result.stderr).toContain("Could not update standard compression");
    expect(existsSync(join(dir, "yolo-mode"))).toBe(false);
    expect(run("compression").stdout).toContain("Compression: balanced");
  });

  it("rejects extra compression arguments before disabling YOLO", () => {
    writeFileSync(join(dir, "yolo-mode"), "on");
    const result = run("compression", "light", "extra");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: tkr compression");
    expect(readFileSync(join(dir, "yolo-mode"), "utf8")).toBe("on");
  });

  it.each(["unknown", "constructor", "__proto__"])("rejects invalid compression level %s without disabling YOLO", (level) => {
    writeFileSync(join(dir, "yolo-mode"), "on");
    const result = run("compression", level);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown level");
    expect(readFileSync(join(dir, "yolo-mode"), "utf8")).toBe("on");
  });

  it.each([
    { label: "reset", args: ["settings", "reset"], answers: [] },
    { label: "recommended configuration", args: ["settings", "configure"], answers: ["1", "n"] },
    { label: "custom normal configuration", args: ["settings", "configure"], answers: ["2", "y", "normal", "y", "n"] }
  ])("leaves YOLO after a successful $label without sending its flag to the server", async ({ args, answers }) => {
    writeFileSync(join(dir, "yolo-mode"), "on");
    const result = await runWithSettings(args, answers);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("YOLO: off (this machine only)");
    expect(existsSync(join(dir, "yolo-mode"))).toBe(false);
    expect(result.requests.some((request) => request.method === "PATCH")).toBe(true);
    expect(result.requests.every((request) => request.url === "/api/v1/settings")).toBe(true);
    expect(JSON.stringify(result.requests)).not.toMatch(/yolo/i);
  });

  it("keeps YOLO enabled when resetting settings fails", async () => {
    writeFileSync(join(dir, "yolo-mode"), "on");
    expect((await runWithSettings(["settings", "reset"], [], 500)).status).toBe(1);
    expect(readFileSync(join(dir, "yolo-mode"), "utf8")).toBe("on");
  });
});
