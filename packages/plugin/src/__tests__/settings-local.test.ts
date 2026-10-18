import { afterEach, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Settings } from "../contracts";

const cli = resolve("packages/plugin/src/bin/tkr.ts");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tkr-local-settings-"));
  seedState(false);
  writeFileSync(join(home, "daemon.spawn.fail"), String(Date.now()));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedState(linked: boolean) {
  writeFileSync(join(home, "state.json"), JSON.stringify({
    token: "tokmizer_local_test", jwt: "local-test-jwt", signingSecret: "local-test-secret",
    plan: "pro", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1,
    installId: "local-test-install", linked, lastHeartbeatOkAt: Date.now()
  }));
}

function env() {
  return {
    ...process.env,
    TOKMIZER_HOME: home,
    TOKMIZER_BASE_URL: "http://127.0.0.1:1",
    TOKMIZER_AUTO_UPDATE: "0",
    TOKMIZER_DAEMON_BIN: join(home, "disabled-daemon.js"),
    TOKMIZER_CLAUDE_COMMANDS_DIR: join(home, "commands"),
    XDG_RUNTIME_DIR: ""
  };
}

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", input: "", timeout: 10000, env: env() });
}

function cached() {
  return JSON.parse(readFileSync(join(home, "settings-cache.json"), "utf8"));
}

function worker(source: string, label = "settings worker") {
  const started = performance.now();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    env: env(), stdio: ["pipe", "pipe", "pipe", "ipc"], timeout: 12000
  });
  let stdout = "";
  let stderr = "";
  let phase = "starting";
  let spawnError: Error | undefined;
  child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-8192); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8192); });
  child.on("error", (error) => { spawnError = error; });
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  const diagnostic = (phase: string, reason: string) => new Error(
    `${label} ${phase}: ${reason}; elapsed=${Math.round(performance.now() - started)}ms; ` +
    `spawn=${spawnError?.message ?? "none"}\nstdout: ${stdout || "<empty>"}\nstderr: ${stderr || "<empty>"}`
  );
  onTestFailed(async () => {
    process.stderr.write(`${diagnostic(phase, `test failed; code=${child.exitCode} signal=${child.signalCode}`).message}\n`);
    child.kill();
    await closed;
  });
  async function nextMessage(nextPhase: string): Promise<unknown> {
    phase = nextPhase;
    const controller = new AbortController();
    try {
      return await Promise.race([
        once(child, "message", { signal: controller.signal }).then(
          ([message]) => message,
          (error: Error) => { throw diagnostic(nextPhase, error.message); }
        ),
        closed.then(([code, signal]) => { throw diagnostic(nextPhase, `exited code=${code} signal=${signal}`); })
      ]);
    } finally {
      controller.abort();
    }
  }
  const send = (message: string) => new Promise<void>((resolve, reject) => {
    child.send(message, (error) => error ? reject(diagnostic(`sending ${message}`, error.message)) : resolve());
  });
  const ready = nextMessage("waiting for ready");
  return { child, closed, ready, nextMessage, send };
}

describe("settings worker diagnostics", () => {
  it("reports a worker failure before readiness instead of waiting for IPC forever", async () => {
    const failed = worker('throw new Error("worker-startup-fixture");');
    try {
      await expect(failed.ready).rejects.toThrow("worker-startup-fixture");
    } finally {
      failed.child.kill();
      await failed.closed;
    }
  }, 3000);

  it("reports an asynchronous worker rejection with the pending round and stderr", async () => {
    const failed = worker(`
      process.send("ready");
      process.on("message", async () => { throw new Error("worker-patch-fixture"); });
    `, "patch worker");
    try {
      expect(await failed.ready).toBe("ready");
      const done = failed.nextMessage("round 7");
      const result = Promise.all([done, failed.send("start")]);
      await expect(result).rejects.toThrow(/patch worker round 7: exited code=1[\s\S]*worker-patch-fixture/);
    } finally {
      failed.child.kill();
      await failed.closed;
    }
  }, 3000);
});

async function online(args: string[], options: { heartbeatStatus?: number; skillStatus?: number; answers?: string[]; env?: Record<string, string> } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const requests: string[] = [];
  let serverSettings = Settings.parse({ telemetryOptIn: false });
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const patch = raw ? JSON.parse(raw) : undefined;
    let body: unknown;
    if (req.url === "/api/v1/settings") {
      if (req.method === "PATCH") serverSettings = Settings.parse({ ...serverSettings, ...patch });
      body = { plan: "pro", settings: serverSettings };
    } else if (req.url === "/api/v1/license/activate") {
      body = { jwt: "linked-test-jwt", signingSecret: "linked-test-secret", plan: "pro", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1 };
    } else if (req.url === "/api/v1/license/heartbeat") {
      if (options.heartbeatStatus && options.heartbeatStatus !== 200) { res.writeHead(options.heartbeatStatus); res.end(); return; }
      body = { jwt: "refreshed-test-jwt", plan: "pro", status: "active", trialEndsAt: null, subEndsAt: null, jwtVersion: 1, settingsRevision: 10, bonusActive: false };
    } else if (req.url === "/api/v1/skills/bundle") {
      if (options.skillStatus && options.skillStatus !== 200) { res.writeHead(options.skillStatus); res.end(); return; }
      const rules = "Reducer test ruleset for light.";
      body = { bundles: [{ slug: "reducer-light", version: 1, fragments: [{ position: 0, body: rules, hash: sign(null, Buffer.from(rules), privateKey).toString("base64url") }] }] };
    } else {
      body = {};
    }
    const text = JSON.stringify(body);
    const timestamp = Date.now();
    res.writeHead(200, {
      "content-type": "application/json",
      "x-tokmizer-resp-ts": String(timestamp),
      "x-tokmizer-resp-sig": sign(null, Buffer.from(`${timestamp}.${text}`), privateKey).toString("base64url")
    });
    res.end(text);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
        timeout: 10000,
        env: { ...env(), TOKMIZER_BASE_URL: `http://127.0.0.1:${address.port}`, TOKMIZER_DEV: "1", TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }).toString(), ...options.env }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.endsWith(": ") && options.answers?.length) child.stdin.write(`${options.answers.shift()}\n`);
      });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
      if (!options.answers?.length) child.stdin.end();
    });
    return { ...result, requests };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("anonymous local settings", () => {
  it("preserves different fields from two processes starting each update together", async () => {
    const workers = [
      { telemetryOptIn: false, filters: { enableAll: false } },
      { outputVerbosity: "normal", filters: { disabled: ["git"] } }
    ].map((patch, index) => worker(`
      const { patchSettings } = await import(${JSON.stringify(pathToFileURL(resolve("packages/plugin/src/settings-client.ts")).href)});
      process.send("ready");
      process.on("message", async () => {
        await patchSettings(${JSON.stringify(patch)});
        process.send("done");
      });
    `, `patch worker ${index + 1}`));
    try {
      expect(await Promise.all(workers.map((entry) => entry.ready))).toEqual(["ready", "ready"]);
      for (let round = 0; round < 20; round++) {
        writeFileSync(join(home, "settings-cache.json"), JSON.stringify(Settings.parse({})));
        const done = workers.map((entry) => entry.nextMessage(`round ${round + 1}`));
        const results = await Promise.all([...done, ...workers.map((entry) => entry.send("start"))]);
        expect(results.slice(0, workers.length)).toEqual(["done", "done"]);
        expect(cached()).toMatchObject({
          telemetryOptIn: false, outputVerbosity: "normal", filters: { enableAll: false, disabled: ["git"] }
        });
      }
      expect(readdirSync(join(home, "settings-cache-locks"))).toEqual([]);
    } finally {
      for (const { child } of workers) child.kill();
      await Promise.all(workers.map((entry) => entry.closed));
    }
  }, 12000);

  it.each([0, 1])("recovers when a process holding ticket %i crashes", async (ticket) => {
    const locks = join(home, "settings-cache-locks");
    mkdirSync(locks);
    const holder = worker(`
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      writeFileSync(join(${JSON.stringify(locks)}, process.pid + "-${randomUUID()}.json"), "${ticket}");
      process.send("ready");
      setInterval(() => {}, 1000);
    `, `ticket ${ticket} holder`);
    let waiting: ReturnType<typeof worker> | undefined;
    try {
      await holder.ready;
      waiting = worker(`
        const { patchSettings } = await import(${JSON.stringify(pathToFileURL(resolve("packages/plugin/src/settings-client.ts")).href)});
        process.send("ready");
        await patchSettings({ telemetryOptIn: false });
        process.exit(0);
      `, `ticket ${ticket} waiter`);
      await waiting.ready;
      await expect.poll(() => readdirSync(locks).filter((file) => file.endsWith(".json")).length, { timeout: 2000 }).toBe(2);
      holder.child.kill("SIGKILL");
      await holder.closed;
      expect(await waiting.closed).toEqual([0, null]);
      expect(cached().telemetryOptIn).toBe(false);
      expect(readdirSync(locks)).toEqual([]);
    } finally {
      holder.child.kill();
      waiting?.child.kill();
      await Promise.all([holder.closed, waiting?.closed]);
    }
  }, 10000);

  it("times out without stealing a live ticket or changing settings", () => {
    const locks = join(home, "settings-cache-locks");
    mkdirSync(locks);
    const owner = `${process.pid}-${randomUUID()}.json`;
    writeFileSync(join(locks, owner), "0");
    writeFileSync(join(home, "settings-cache.json"), JSON.stringify(Settings.parse({})));
    const before = cached();
    const result = run("settings", "set", "telemetryOptIn", "false");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Timed out waiting for local settings lock");
    expect(cached()).toEqual(before);
    expect(readdirSync(locks)).toEqual([owner]);
  }, 10000);

  it.each([
    ["light", "normal"], ["normal", "normal"], ["balanced", "compact"],
    ["compact", "compact"], ["max", "minimal"], ["minimal", "minimal"]
  ])("persists compression alias %s as %s offline across processes", (alias, wire) => {
    const changed = run("compression", alias);
    expect(changed.status).toBe(0);
    expect(cached().outputVerbosity).toBe(wire);
    expect(run("settings", "show").stdout).toContain(`"outputVerbosity": "${wire}"`);
  });

  it("preserves local choices through a signed heartbeat revision update", async () => {
    const settings = Settings.parse({ outputVerbosity: "normal", reducer: "light", telemetryOptIn: false, filters: { enableAll: false, disabled: ["git"] } });
    writeFileSync(join(home, "settings-cache.json"), JSON.stringify(settings));
    const result = await online(["heartbeat"]);
    expect(result.status).toBe(0);
    expect(result.requests).not.toContain("GET /api/v1/settings");
    expect(cached()).toEqual(settings);
    expect(run("settings", "show").stdout).toContain('"reducer": "light"');
  });

  it("merges nested filter choices without erasing siblings and rejects invalid levels", () => {
    writeFileSync(join(home, "settings-cache.json"), JSON.stringify(Settings.parse({ filters: { enableAll: false, disabled: ["git"] } })));
    expect(run("settings", "set", "filters.disabled", '["git","ls"]').status).toBe(0);
    expect(cached().filters).toEqual({ enableAll: false, disabled: ["git", "ls"] });
    const before = cached();
    expect(run("settings", "set", "outputVerbosity", "invalid").status).toBe(1);
    expect(cached()).toEqual(before);
  });

  it("keeps linked accounts on signed server synchronization", async () => {
    seedState(true);
    const result = await online(["compression", "max"]);
    expect(result.status).toBe(0);
    expect(result.requests).toContain("PATCH /api/v1/settings");
    expect(cached().outputVerbosity).toBe("minimal");
    expect(run("compression", "light").status).toBe(1);
    expect(cached().outputVerbosity).toBe("minimal");
  });

  it.each(["invalid", "[]"])("rejects malformed filter replacement %s without changing local settings", (value) => {
    writeFileSync(join(home, "settings-cache.json"), JSON.stringify(Settings.parse({ filters: { enableAll: false, disabled: ["git"] } })));
    const before = cached();
    expect(run("settings", "set", "filters", value).status).toBe(1);
    expect(cached()).toEqual(before);
  });

  it("resets every local setting to its schema default", () => {
    writeFileSync(join(home, "settings-cache.json"), JSON.stringify(Settings.parse({
      enabled: false, telemetryOptIn: false, outputVerbosity: "minimal", reducer: "max", filters: { enableAll: false, disabled: ["git"] }
    })));
    writeFileSync(join(home, "yolo-mode"), "on");
    expect(run("settings", "reset").status).toBe(0);
    expect(cached()).toEqual(Settings.parse({ telemetryOptIn: false }));
    expect(run("yolo", "status").stdout).toContain("YOLO: off");
  });

  it("keeps a telemetry refusal through settings reset until telemetry is turned on", () => {
    expect(run("telemetry", "off").status).toBe(0);
    expect(run("settings", "reset").status).toBe(0);
    expect(cached().telemetryOptIn).toBe(false);
    expect(run("telemetry", "status").stdout).toContain("Telemetry: off");
    expect(run("telemetry", "on").status).toBe(0);
    expect(run("settings", "reset").status).toBe(0);
    expect(cached().telemetryOptIn).toBe(true);
  });

  it("keeps a telemetry refusal through unlink while resetting the other settings", () => {
    expect(run("compression", "max").status).toBe(0);
    expect(run("telemetry", "off").status).toBe(0);
    expect(run("unlink").status).toBe(0);
    expect(cached()).toEqual(Settings.parse({ telemetryOptIn: false }));
    expect(run("telemetry", "status").stdout).toContain("Telemetry: off");
  });

  it("does not leave a settings file after unlink when telemetry was on", () => {
    expect(run("compression", "max").status).toBe(0);
    expect(run("unlink").status).toBe(0);
    expect(readdirSync(home)).not.toContain("settings-cache.json");
  });

  it("describes anonymous configuration as local instead of editable in the account dashboard", async () => {
    const result = await online(["settings", "configure"], { answers: ["1", "n"] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("only on this machine");
    expect(result.stdout).not.toContain("https://tokmizer.com/dashboard/settings");
    expect(result.requests).toEqual([]);
  });

  it("returns to account synchronization after linking without claiming untouched defaults", async () => {
    expect(run("compression", "light").status).toBe(0);
    const linked = await online(["link", "tokmizer_linked_fixture"]);
    expect(linked.status).toBe(0);
    expect(linked.stdout).not.toContain("Settings stay on the recommended defaults");
    expect(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).linked).toBe(true);
    const synced = await online(["settings", "show"]);
    expect(synced.status).toBe(0);
    expect(synced.requests).toContain("GET /api/v1/settings");
    expect(cached().outputVerbosity).toBe("compact");
  });
});

describe("commands that must not enroll this device", () => {
  const noCi = { CI: "", GITHUB_ACTIONS: "" };

  beforeEach(() => {
    rmSync(join(home, "state.json"), { force: true });
  });

  it.each([["telemetry", "off"], ["telemetry", "status"], ["telemetry", "forget"], ["network", "off"], ["network", "status"]])("tkr %s %s sends no enrollment", async (...args) => {
    const result = await online(args, { env: noCi });
    expect(result.status).toBe(0);
    expect(result.requests).not.toContain("POST /api/v1/license/enroll");
  });

  it("still enrolls for telemetry on", async () => {
    const result = await online(["telemetry", "on"], { env: noCi });
    expect(result.requests).toContain("POST /api/v1/license/enroll");
  });
});

describe("reducer activation feedback", () => {
  it.each([{ heartbeatStatus: 503 }, { skillStatus: 503 }])("does not promise activation without the ruleset after failure %j", async (options) => {
    seedState(true);
    const result = await online(["reducer", "light"], options);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("Takes full effect");
    expect(result.stderr).toMatch(/ruleset.*unavailable/i);
    expect(cached().reducer).toBe("light");
  });

  it("reports agent readiness after downloading a signed ruleset", async () => {
    seedState(true);
    const result = await online(["reducer", "light"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("next session of each agent set up with Tokmizer");
    expect(readFileSync(join(home, "skills", "reducer-light.md"), "utf8")).toBe("Reducer test ruleset for light.");
  });

  it("can activate offline for an anonymous user with a valid cached ruleset", () => {
    mkdirSync(join(home, "skills"));
    writeFileSync(join(home, "skills", "reducer-light.md"), "Cached ruleset.");
    const result = run("reducer", "light");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("next session of each agent set up with Tokmizer");
    expect(cached().reducer).toBe("light");
  });

  it("reports the disabled global setting instead of promising an active reducer", () => {
    mkdirSync(join(home, "skills"));
    writeFileSync(join(home, "skills", "reducer-light.md"), "Cached ruleset.");
    writeFileSync(join(home, "settings-cache.json"), JSON.stringify(Settings.parse({ enabled: false })));
    const result = run("reducer", "light");
    expect(result.stdout + result.stderr).toContain("Tokmizer is disabled");
    expect(result.stdout).not.toContain("Takes full effect");
    expect(cached().enabled).toBe(false);
  });
});
