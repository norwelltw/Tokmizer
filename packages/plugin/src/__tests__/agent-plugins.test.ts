import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configBackupFile } from "../config-backup";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_SETUPS, agentIntegrationInstalled, agentSetupFor, installAgentShim, removeAgentShim, type AgentSetup } from "../agent-plugins";
import { SHIM_ARGV_PLACEHOLDER, SHIM_CONTEXT_PLACEHOLDER, renderShim, tkrArgv } from "../agent-shim-files";

const savedTokmizerHome = process.env.TOKMIZER_HOME;
import { hasNativeHook, nativeHookSetupCommand } from "../host-detect";

const TEMPLATES = resolve("packages/plugin/agent-plugins");
const shims = AGENT_SETUPS.filter((s): s is AgentSetup & { kind: "shim" } => s.kind === "shim");

let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "HERMES_HOME", "VIBE_HOME"];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-agent-plugins-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  for (const k of ENV.slice(2)) delete process.env[k];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function fakeTkr(body: string): string[] {
  const script = join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, body);
  return [process.execPath, script];
}

const ECHO_REWRITE = `
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (input.startsWith("cd ")) return;
  process.stdout.write("wrapped[" + args.join(" ") + "] " + input);
});
`;

const FAILURES: Record<string, () => string[]> = {
  "missing binary": () => [join(dir, "does-not-exist")],
  "non-zero exit": () => fakeTkr('process.stdout.write("garbage"); process.exit(1);'),
  "empty output": () => fakeTkr("process.stdin.resume();")
};

const contextFile = (): string => join(dir, "reducer-context.txt");

async function loadShim(template: string, argv: string[]): Promise<any> {
  const file = join(dir, `shim-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, renderShim(readFileSync(join(TEMPLATES, template), "utf8"), argv, contextFile()));
  return (await import(pathToFileURL(file).href)).default;
}

type Driver = (shim: any, command: string) => Promise<string>;

const DRIVERS: Record<string, { template: string; drive: Driver }> = {
  "opencode 1.x": {
    template: "opencode.js",
    drive: async (shim, command) => {
      const output = { args: { command, timeout: 1 } };
      await (await shim.server())["tool.execute.before"]({ tool: "bash", sessionID: "s" }, output);
      expect(output.args.timeout).toBe(1);
      return output.args.command;
    }
  },
  "opencode 2.x": {
    template: "opencode.js",
    drive: async (shim, command) => {
      let hook: any;
      await shim.setup({ tool: { hook: async (name: string, fn: any) => { expect(name).toBe("execute.before"); hook = fn; } } });
      const event = { tool: "shell", input: { command } };
      await hook(event);
      return event.input.command;
    }
  },
  kilo: {
    template: "kilo.js",
    drive: async (shim, command) => {
      const output = { args: { command, timeout: 1 } };
      await (await shim.server())["tool.execute.before"]({ tool: "bash", sessionID: "s" }, output);
      expect(output.args.timeout).toBe(1);
      return output.args.command;
    }
  },
  amp: {
    template: "amp.js",
    drive: async (shim, command) => {
      let handler: any;
      shim({ on: (name: string, fn: any) => { expect(name).toBe("tool.call"); handler = fn; }, helpers: { shellCommandFromToolCall: (e: any) => ({ command: e.input.cmd }) } });
      const result = await handler({ tool: "Bash", input: { cmd: command, other: 1 }, thread: { id: "t" } });
      if (result.action === "allow") return command;
      expect(result.action).toBe("modify");
      expect(result.input.other).toBe(1);
      return result.input.cmd;
    }
  },
  pi: {
    template: "pi.js",
    drive: async (shim, command) => {
      let handler: any;
      shim({ on: (name: string, fn: any) => { expect(name).toBe("tool_call"); handler = fn; } });
      const event = { toolName: "bash", input: { command } };
      expect(await handler(event)).toBeUndefined();
      return event.input.command;
    }
  },
  omp: {
    template: "omp.js",
    drive: async (shim, command) => {
      let handler: any;
      shim({ on: (name: string, fn: any) => { expect(name).toBe("tool_call"); handler = fn; } });
      const event = { toolName: "bash", input: { command, timeout: 2 } };
      const result = await handler(event);
      expect(event.input.command).toBe(command);
      if (!result) return command;
      expect(result.input.timeout).toBe(2);
      return result.input.command;
    }
  },
  openclaw: {
    template: "openclaw/index.js",
    drive: async (shim, command) => {
      let handler: any;
      shim.register({ on: (name: string, fn: any) => { if (name === "before_tool_call") handler = fn; } });
      const result = await handler({ toolName: "exec", params: { command, workdir: "/w" } });
      if (!result) return command;
      expect(result.params.workdir).toBe("/w");
      return result.params.command;
    }
  }
};

describe("agent plugin shims", () => {
  for (const [name, { template, drive }] of Object.entries(DRIVERS)) {
    describe(name, () => {
      it("replaces the command with the output of tkr rewrite", async () => {
        const argv = fakeTkr(ECHO_REWRITE);
        const host = template.replace(/\/.*$|\.js$/g, "");
        const out = await drive(await loadShim(template, argv), "git log");
        expect(out).toMatch(new RegExp(`^wrapped\\[rewrite --host ${host}( --session \\S+)?\\] git log$`));
      });

      it("keeps the command when tkr leaves it unchanged", async () => {
        expect(await drive(await loadShim(template, fakeTkr(ECHO_REWRITE)), "cd /tmp")).toBe("cd /tmp");
      });

      for (const [failure, argv] of Object.entries(FAILURES)) {
        it(`runs the command as typed on ${failure}`, async () => {
          expect(await drive(await loadShim(template, argv()), "git log")).toBe("git log");
        });
      }
    });
  }

  it("ignores non-shell tools", async () => {
    const argv = fakeTkr(ECHO_REWRITE);
    const output = { args: { command: "git log" } };
    await (await (await loadShim("opencode.js", argv)).server())["tool.execute.before"]({ tool: "read" }, output);
    expect(output.args.command).toBe("git log");
    let pi: any;
    (await loadShim("pi.js", argv))({ on: (_: string, fn: any) => (pi = fn) });
    const event = { toolName: "powershell", input: { command: "git log" } };
    await pi(event);
    expect(event.input.command).toBe("git log");
    let claw: any;
    (await loadShim("openclaw/index.js", argv)).register({ on: (name: string, fn: any) => { if (name === "before_tool_call") claw = fn; } });
    expect(await claw({ toolName: "exec", toolKind: "code_mode_exec", params: { command: "git log" } })).toBeUndefined();
  });

  it("gives up after its timeout and keeps the command", async () => {
    const started = Date.now();
    expect(await DRIVERS.pi!.drive(await loadShim("pi.js", fakeTkr("setTimeout(() => {}, 20000);")), "git log")).toBe("git log");
    expect(Date.now() - started).toBeLessThan(6000);
  }, 10000);

  const python = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!python)("hermes returns a modify directive and stays silent on failure", () => {
    const run = (argv: string[], tool: string, command: string) => {
      const pkg = join(dir, `h${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(pkg, "tokmizer"), { recursive: true });
      writeFileSync(join(pkg, "tokmizer", "__init__.py"), renderShim(readFileSync(join(TEMPLATES, "hermes", "__init__.py"), "utf8"), argv));
      const code = [
        "import json, sys",
        `sys.path.insert(0, ${JSON.stringify(pkg)})`,
        "import tokmizer",
        "hooks = {}",
        "tokmizer.register(type('Ctx', (), {'register_hook': lambda self, n, f: hooks.__setitem__(n, f)})())",
        `print(json.dumps(hooks['pre_tool_call'](tool_name=${JSON.stringify(tool)}, args={'command': ${JSON.stringify(command)}, 'timeout': 5}, task_id='t', session_id='s')))`
      ].join("\n");
      return JSON.parse(spawnSync("python3", ["-I", "-c", code], { encoding: "utf8" }).stdout);
    };
    expect(run(fakeTkr(ECHO_REWRITE), "terminal", "git log")).toEqual({ action: "modify", args: { command: "wrapped[rewrite --host hermes --session s] git log" } });
    expect(run(fakeTkr(ECHO_REWRITE), "terminal", "cd /tmp")).toBeNull();
    expect(run(fakeTkr(ECHO_REWRITE), "read_file", "git log")).toBeNull();
    for (const argv of Object.values(FAILURES)) expect(run(argv(), "terminal", "git log")).toBeNull();
  });
});

const SPAWN_SPY = `
require("node:fs").writeFileSync(process.env.TKR_SPY_FILE, "spawned");
`;

describe("reducer injection from agent plugins", () => {
  const spy = (): string[] => {
    const script = join(dir, "spy.cjs");
    writeFileSync(script, SPAWN_SPY);
    process.env.TKR_SPY_FILE = join(dir, "spawned");
    return [process.execPath, script];
  };
  afterEach(() => {
    delete process.env.TKR_SPY_FILE;
  });

  for (const template of ["opencode.js", "kilo.js"]) {
    it(`${template} appends the ruleset file to the system prompt, keeps it stable per session, and never spawns tkr`, async () => {
      writeFileSync(contextFile(), "RULESET max\n");
      const hooks = await (await loadShim(template, spy())).server();
      const first = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, first);
      expect(first.system).toEqual(["base", "RULESET max"]);
      writeFileSync(contextFile(), "RULESET light");
      const again = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, again);
      expect(again.system).toEqual(["base", "RULESET max"]);
      const other = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "s2", model: {} }, other);
      expect(other.system).toEqual(["base", "RULESET light"]);
      expect(existsSync(join(dir, "spawned"))).toBe(false);
    });

    it(`${template} adds nothing when the ruleset file is missing or empty`, async () => {
      const hooks = await (await loadShim(template, spy())).server();
      const out = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, out);
      expect(out.system).toEqual(["base"]);
      writeFileSync(contextFile(), " \n");
      await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, out);
      expect(out.system).toEqual(["base"]);
      writeFileSync(contextFile(), "RULESET max");
      await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, out);
      expect(out.system).toEqual(["base", "RULESET max"]);
    });
  }

  it("openclaw appends the ruleset file as system context, stays silent without it, and never spawns tkr", async () => {
    const hooks: Record<string, any> = {};
    (await loadShim("openclaw/index.js", spy())).register({ on: (name: string, fn: any) => (hooks[name] = fn) });
    expect(await hooks.before_prompt_build({})).toBeUndefined();
    writeFileSync(contextFile(), "RULESET max\n");
    expect(await hooks.before_prompt_build({})).toEqual({ appendSystemContext: "RULESET max" });
    expect(existsSync(join(dir, "spawned"))).toBe(false);
  });

  it("renders the ruleset path as a valid literal", async () => {
    const odd = join(dir, "it's \"q\" \\x");
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, "reducer-context.txt"), "RULESET odd");
    const file = join(dir, "odd-shim.mjs");
    writeFileSync(file, renderShim(readFileSync(join(TEMPLATES, "opencode.js"), "utf8"), ["/x/tkr"], join(odd, "reducer-context.txt")));
    const hooks = await (await import(pathToFileURL(file).href)).default.server();
    const out = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, out);
    expect(out.system).toEqual(["RULESET odd"]);
  });

  const py = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!py)("hermes registers a system prompt section that renders the ruleset and stays empty on failure", () => {
    const section = (argv: string[], withApi: boolean) => {
      const pkg = join(dir, `h${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(pkg, "tokmizer"), { recursive: true });
      writeFileSync(join(pkg, "tokmizer", "__init__.py"), renderShim(readFileSync(join(TEMPLATES, "hermes", "__init__.py"), "utf8"), argv, contextFile()));
      const api = withApi ? "'register_system_prompt_section': lambda self, n, f, **kw: sections.__setitem__(n, (f, kw))," : "";
      const code = [
        "import json, sys",
        `sys.path.insert(0, ${JSON.stringify(pkg)})`,
        "import tokmizer",
        "hooks = {}",
        "sections = {}",
        `tokmizer.register(type('Ctx', (), {'register_hook': lambda self, n, f: hooks.__setitem__(n, f), ${api}})())`,
        "out = {k: [f(), kw] for k, (f, kw) in sections.items()}",
        "print(json.dumps({'hooks': sorted(hooks), 'sections': out}))"
      ].join("\n");
      return JSON.parse(spawnSync("python3", ["-I", "-c", code], { encoding: "utf8" }).stdout);
    };
    expect(section(spy(), true).sections["tokmizer.reducer"][0]).toBe("");
    writeFileSync(contextFile(), "RULESET max\n");
    expect(section(spy(), true)).toEqual({ hooks: ["pre_tool_call"], sections: { "tokmizer.reducer": ["RULESET max", { position: "after_memory", max_chars: 8000 }] } });
    expect(section(spy(), false)).toEqual({ hooks: ["pre_tool_call"], sections: {} });
    expect(existsSync(join(dir, "spawned"))).toBe(false);
  });
});

describe("shim templates", () => {
  it("carry the argv placeholder, their host and no rewrite rules", () => {
    for (const setup of shims) {
      const main = readFileSync(join(TEMPLATES, setup.files()[0]!.template), "utf8");
      expect(main).toContain(SHIM_ARGV_PLACEHOLDER);
      expect(main).toContain(`["rewrite", "--host", "${setup.host}"]`);
      expect(main).not.toMatch(/tkr-exec|smart-|filters|EXCEPTIONS|INTERPRETERS/);
      expect(main).not.toMatch(/^\s*(\/\/|#(?!!)|\/\*)/m);
      expect(main).not.toMatch(/reducer", "--context|child_process[\s\S]*reducer --context/);
      expect(main.includes(SHIM_CONTEXT_PLACEHOLDER)).toBe(["opencode", "kilo", "openclaw", "hermes"].includes(setup.host));
    }
  });

  it("bake the Tokmizer home's ruleset path into installed plugins", async () => {
    process.env.TOKMIZER_HOME = join(dir, "custom-home");
    try {
      const setup = agentSetupFor("setup-opencode") as AgentSetup & { kind: "shim" };
      await installAgentShim(setup, TEMPLATES, ["/x/tkr"]);
      expect(readFileSync(setup.files()[0]!.target, "utf8")).toContain(`const CONTEXT_FILE = ${JSON.stringify(join(dir, "custom-home", "reducer-context.txt"))};`);
    } finally {
      process.env.TOKMIZER_HOME = savedTokmizerHome;
    }
  });
});

describe("tkrArgv", () => {
  it("prefers an executable tkr on PATH and falls back to node + the installed script", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    expect(tkrArgv(bin, "/pkg/dist/bin/tkr.js", "darwin", "/usr/bin/node")).toEqual(["/usr/bin/node", "/pkg/dist/bin/tkr.js"]);
    writeFileSync(join(bin, "tkr"), "#!/bin/sh\n", { mode: 0o755 });
    expect(tkrArgv(`/x/node_modules/.bin:${bin}`, "/pkg/dist/bin/tkr.js", "darwin", "/usr/bin/node")).toEqual([join(bin, "tkr")]);
    expect(tkrArgv(bin, "C:\\pkg\\tkr.js", "win32", "C:\\node.exe")).toEqual(["C:\\node.exe", "C:\\pkg\\tkr.js"]);
  });

  it("renders paths that need escaping as valid literals", async () => {
    const shim = await loadShim("pi.js", ["/a b/it's \"q\"\\x"]);
    expect(typeof shim).toBe("function");
  });
});

describe("installAgentShim / removeAgentShim", () => {
  const argv = ["/usr/bin/node", "/pkg/tkr.js"];

  for (const setup of shims) {
    it(`${setup.host}: installs, is idempotent, refreshes, preserves neighbours and removes only its files`, async () => {
      const files = setup.files();
      const neighbourDir = join(files[0]!.target, "..", "..");
      mkdirSync(neighbourDir, { recursive: true });
      writeFileSync(join(neighbourDir, "user-plugin.js"), "export default {}\n");
      expect(await installAgentShim(setup, TEMPLATES, argv)).toBe("added");
      for (const f of files) expect(existsSync(f.target)).toBe(true);
      expect(readFileSync(files[0]!.target, "utf8")).toContain(JSON.stringify(argv));
      expect(agentIntegrationInstalled(setup)).toBe(true);
      expect(hasNativeHook(setup.host as never)).toBe(true);
      expect(nativeHookSetupCommand(setup.host as never)).toBeNull();
      expect(await installAgentShim(setup, TEMPLATES, argv)).toBe("present");
      expect(await installAgentShim(setup, TEMPLATES, ["/other/tkr"])).toBe("updated");
      expect(await removeAgentShim(setup)).toBe("removed");
      for (const f of files) expect(existsSync(f.target)).toBe(false);
      expect(readFileSync(join(neighbourDir, "user-plugin.js"), "utf8")).toBe("export default {}\n");
      expect(agentIntegrationInstalled(setup)).toBe(false);
      expect(nativeHookSetupCommand(setup.host as never)).toBe(`tkr ${setup.command}`);
      expect(await removeAgentShim(setup)).toBe("absent");
    });
  }

  it("backs up a foreign file in its place and never deletes a file it did not write", async () => {
    const setup = agentSetupFor("setup-pi") as AgentSetup & { kind: "shim" };
    const target = setup.files()[0]!.target;
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "export default function () {}\n");
    expect(await removeAgentShim(setup)).toBe("absent");
    expect(existsSync(target)).toBe(true);
    expect(await installAgentShim(setup, TEMPLATES, argv)).toBe("added");
    expect(readFileSync(configBackupFile(target), "utf8")).toBe("export default function () {}\n");
  });

  it("follows the documented config-dir overrides", () => {
    process.env.XDG_CONFIG_HOME = join(dir, "xdg");
    process.env.PI_CODING_AGENT_DIR = join(dir, "pi");
    process.env.HERMES_HOME = join(dir, "hermes");
    expect(agentSetupFor("setup-opencode")!.kind === "shim" && (agentSetupFor("setup-opencode") as any).files()[0].target).toBe(join(dir, "xdg", "opencode", "plugins", "tokmizer.js"));
    expect((agentSetupFor("setup-kilo") as any).files()[0].target).toBe(join(dir, "xdg", "kilo", "plugin", "tokmizer.js"));
    expect((agentSetupFor("setup-amp") as any).files()[0].target).toBe(join(dir, "xdg", "amp", "plugins", "tokmizer.js"));
    expect((agentSetupFor("setup-pi") as any).files()[0].target).toBe(join(dir, "pi", "extensions", "tokmizer.js"));
    expect((agentSetupFor("setup-hermes") as any).files()[0].target).toBe(join(dir, "hermes", "plugins", "tokmizer", "__init__.py"));
    expect((agentSetupFor("setup-omp") as any).files()[0].target).toBe(join(dir, ".omp", "agent", "extensions", "tokmizer.js"));
    expect((agentSetupFor("setup-openclaw") as any).files()[0].target).toBe(join(dir, ".openclaw", "extensions", "tokmizer", "index.js"));
  });
});

describe("tkr setup-<agent> CLI", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", resolve("packages/plugin/src/bin/tkr.ts"), ...args], {
      encoding: "utf8",
      input: "",
      timeout: 20000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CI: "1", TOKMIZER_HOME: join(dir, "t"), TOKMIZER_BASE_URL: "http://127.0.0.1:1", TOKMIZER_AUTO_UPDATE: "0", PATH: "" }
    });

  it("installs, reports, and removes every integration", () => {
    for (const setup of AGENT_SETUPS) {
      const first = run(setup.command);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain(`Added the tokmizer ${setup.label} integration`);
      expect(run(setup.command).stdout).toContain(`${setup.label} integration already set`);
    }
    const discover = run("discover").stdout;
    for (const setup of AGENT_SETUPS) expect(discover).toMatch(new RegExp(`  ${setup.label} +✅ optimized automatically`));
    for (const setup of AGENT_SETUPS) {
      expect(run(setup.command, "--remove").stdout).toContain(`Removed the tokmizer ${setup.label} integration`);
      expect(run(setup.command, "--remove").stdout).toContain("No tokmizer integration found");
    }
    expect(run("setup-pi", "--bogus").status).toBe(1);
    const leftovers = readdirSync(dir).filter((f) => f !== "t" && !f.startsWith("fake-"));
    for (const top of leftovers) {
      const walk = (p: string): string[] => (existsSync(p) && readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)]))) || [];
      for (const f of walk(join(dir, top)).filter((p) => !p.endsWith(".tkr-bak"))) expect(readFileSync(f, "utf8")).not.toContain("tokmizer-rewrite");
    }
  }, 120000);
});
