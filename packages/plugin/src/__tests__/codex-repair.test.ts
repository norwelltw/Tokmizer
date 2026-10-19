import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configBackupFile } from "../config-backup";
import { claudeFormHook, codexConfigFile, codexFindings, codexPluginProvidesHook, codexPlugins, disableLegacyPlugins, stripJsonHooks, stripTomlHooks } from "../codex-repair";
import { codexDoctorFix, codexDoctorLines, codexHookInstalled, codexHooksFile, ensureCodexHook, setupCodexHook } from "../codex-hooks";

const CLAUDE_FORMS = [
  "'/opt/homebrew/bin/tkr-exec' --pre-tool-use",
  "[ ! -x '/Users/a/.local/bin/tkr-exec' ] || exec '/Users/a/.local/bin/tkr-exec' --post-tool-use",
  "\"C:\\Users\\a\\AppData\\tkr-exec.exe\" --pre-tool-use",
  "tkr-exec --session-start",
  "'/opt/homebrew/bin/tkr' hook pre-tool-use",
  "[ ! -x '/p/tkr' ] || exec '/p/tkr' hook reducer-session-start",
  "tkr hook session-recap",
  "node \"/usr/local/lib/node_modules/@tokmizer/plugin/dist/hooks-host/pre-tool-use.js\"",
  "node \"/Users/a/.claude/plugins/cache/tokmizer/tokmizer/0.9.58/dist/hooks-host/post-tool-use.js\"",
  "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks-host/pre-tool-use.js\"",
  "node \"${CLAUDE_PLUGIN_ROOT}/hooks/on-session-start.mjs\""
];

const OTHER_COMMANDS = [
  "'/opt/homebrew/bin/tkr' hook codex",
  "[ ! -f '/h/.tokmizer/hook-launch' ] || exec /bin/sh '/h/.tokmizer/hook-launch' tkr-codex-hook",
  "node '/x/dist/bin/tkr-codex-hook.js'",
  "'/p/tkr' hook context --format hso --kind session tkr-context-hook",
  "/usr/bin/python3 .codex/hooks/pre_tool_use_policy.py",
  "node /other/dist/hooks-host/pre-tool-use.js",
  "my-tkr-exec --pre-tool-use-like",
  "tkr-exec git status",
  42
];

describe("claudeFormHook", () => {
  it.each(CLAUDE_FORMS)("recognises the Claude Code Tokmizer hook %s", (command) => {
    expect(claudeFormHook(command)).toBe(true);
  });

  it.each(OTHER_COMMANDS)("leaves %s alone", (command) => {
    expect(claudeFormHook(command)).toBe(false);
  });
});

describe("stripJsonHooks", () => {
  it("removes only the Claude Code Tokmizer hooks and drops emptied groups and events", () => {
    const parsed = {
      other: true,
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: CLAUDE_FORMS[0], timeout: 5 }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "node '/x/dist/bin/tkr-codex-hook.js'", timeout: 10 }, { type: "command", command: CLAUDE_FORMS[4] }] }
        ],
        PostToolUse: [{ matcher: "Read|Grep|Glob|Bash", hooks: [{ type: "command", command: CLAUDE_FORMS[1], timeout: 10 }] }],
        Stop: [{ hooks: [{ type: "command", command: "orca-stop.sh" }] }],
        Odd: "kept"
      }
    };
    expect(stripJsonHooks(parsed, claudeFormHook)).toEqual([CLAUDE_FORMS[0], CLAUDE_FORMS[4], CLAUDE_FORMS[1]]);
    expect(parsed).toEqual({
      other: true,
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node '/x/dist/bin/tkr-codex-hook.js'", timeout: 10 }] }],
        Stop: [{ hooks: [{ type: "command", command: "orca-stop.sh" }] }],
        Odd: "kept"
      }
    });
  });
});

describe("stripTomlHooks", () => {
  const user = [
    "model = \"gpt-5.5\"",
    "",
    "[[hooks.PreToolUse]]",
    "matcher = \"^Bash$\"",
    "",
    "[[hooks.PreToolUse.hooks]]",
    "type = \"command\"",
    "command = '/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py\"'",
    "timeout = 30",
    ""
  ];
  const imported = [
    "[[hooks.PreToolUse]]",
    "matcher = \"Bash\"",
    "",
    "[[hooks.PreToolUse.hooks]]",
    "type = \"command\"",
    "command = \"'/opt/homebrew/bin/tkr-exec' --pre-tool-use\"",
    "timeout = 5",
    "",
    "[[hooks.PostToolUse]]",
    "matcher = \"Bash\"",
    "",
    "[[hooks.PostToolUse.hooks]]",
    "type = \"command\"",
    "command = \"'/opt/homebrew/bin/tkr' hook post-tool-use\"",
    "",
    "[plugins.\"github@openai\"]",
    "enabled = true",
    ""
  ];

  it("removes the imported tables and keeps the user's hooks and settings byte for byte", () => {
    const scan = stripTomlHooks([...user, ...imported].join("\n"), claudeFormHook);
    expect(scan.removed).toEqual(["\"'/opt/homebrew/bin/tkr-exec' --pre-tool-use\"", "\"'/opt/homebrew/bin/tkr' hook post-tool-use\""]);
    expect(scan.inline).toEqual([]);
    expect(scan.text).toBe([...user, "[plugins.\"github@openai\"]", "enabled = true", ""].join("\n"));
  });

  it("keeps a group that still holds a user hook, and preserves CRLF", () => {
    const text = [
      "[[hooks.PreToolUse]]",
      "matcher = \"Bash\"",
      "[[hooks.PreToolUse.hooks]]",
      "command = \"'/p/tkr-exec' --pre-tool-use\"",
      "[[hooks.PreToolUse.hooks]]",
      "command = \"mine.sh\"",
      ""
    ].join("\r\n");
    expect(stripTomlHooks(text, claudeFormHook).text).toBe(["[[hooks.PreToolUse]]", "matcher = \"Bash\"", "[[hooks.PreToolUse.hooks]]", "command = \"mine.sh\"", ""].join("\r\n"));
  });

  it("reports hooks written in a form it cannot edit safely", () => {
    for (const text of [
      "[[hooks.PreToolUse]]\nmatcher = \"Bash\"\nhooks = [{ type = \"command\", command = \"'/p/tkr-exec' --pre-tool-use\" }]\n",
      "[hooks]\nPreToolUse = [{ matcher = \"Bash\", hooks = [{ command = \"'/p/tkr' hook pre-tool-use\" }] }]\n"
    ]) {
      const scan = stripTomlHooks(text, claudeFormHook);
      expect(scan.text).toBe(text);
      expect(scan.removed).toEqual([]);
      expect(scan.inline).toHaveLength(1);
    }
  });

  it("keeps tables whose quoted keys hold commas, brackets, equals signs or hashes", () => {
    const keep = [
      "[projects.\"/Users/me/code/a,b\"]",
      "trust_level = \"trusted\"",
      "[projects.\"/Users/me/code/[old]\"]",
      "trust_level = \"trusted\"",
      "[projects.'/Users/me/x=y#z']",
      "trust_level = \"trusted\"",
      "[mcp_servers.keep]",
      "command = \"srv\"",
      ""
    ];
    const text = ["[[hooks.PreToolUse]]", "matcher = \"Bash\"", "[[hooks.PreToolUse.hooks]]", "command = \"'/p/tkr' hook pre-tool-use\"", ...keep].join("\n");
    const scan = stripTomlHooks(text, claudeFormHook);
    expect(scan.removed).toHaveLength(1);
    expect(scan.text).toBe(keep.join("\n"));
  });

  it("leaves the file alone when the edit would change anything outside the hooks", () => {
    const text = ["[[hooks.PreToolUse]]", "matcher = \"Bash\"", "[[hooks.PreToolUse.hooks]]", "command = \"'/p/tkr' hook pre-tool-use\"", "[ projects . \"odd\" ]  # weird spacing", "trust_level = \"trusted\"", "[a.\"b\" .c]", "x = 1", ""].join("\n");
    const scan = stripTomlHooks(text.replace("[a.\"b\" .c]", "[a.\"b\" .c] extra"), claudeFormHook);
    expect(scan.text).toBe(text.replace("[a.\"b\" .c]", "[a.\"b\" .c] extra"));
    expect(scan.removed).toEqual([]);
  });

  it("handles quoted event keys and keeps the comment that belongs to the next table", () => {
    const text = "[[hooks.\"PreToolUse\"]]\nmatcher = \"Bash\"\n[[hooks.\"PreToolUse\".hooks]]\ncommand = \"'/p/tkr-exec' --pre-tool-use\"\n\n# my model\n[profiles.x]\nmodel = \"o3\"\n";
    expect(stripTomlHooks(text, claudeFormHook).text).toBe("# my model\n[profiles.x]\nmodel = \"o3\"\n");
  });

  it("does not take array rows or multi-line strings for table headers", () => {
    const text = `[plugins."tokmizer@tokmizer"]\nnotes = """\n[not.a.table]\n"""\nlist = [\n  [1, 2],\n]\nenabled = true\n`;
    expect(disableLegacyPlugins(text, ["tokmizer@tokmizer"])).toBe(text.replace("enabled = true", "enabled = false"));
  });

  it("changes nothing without Tokmizer Claude Code hooks", () => {
    const text = user.join("\n");
    expect(stripTomlHooks(text, claudeFormHook)).toEqual({ text, removed: [], inline: [] });
  });
});

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-codex-repair-"));
  saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved;
});

function cachePlugin(marketplace: string, version: string, codexManifest: boolean) {
  const root = join(dir, "plugins", "cache", marketplace, "tokmizer", version);
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "hooks.json"), "{}");
  if (codexManifest) {
    mkdirSync(join(root, ".codex-plugin"), { recursive: true });
    writeFileSync(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "tokmizer", hooks: "./codex-hooks/hooks.json" }));
  }
}

const enabledPlugin = (marketplace = "tokmizer", enabled = "true") => `[plugins."tokmizer@${marketplace}"]\nenabled = ${enabled}\n`;

describe("Codex plugin detection", () => {
  it("tells a fixed plugin from an old one that loads the Claude hooks", () => {
    writeFileSync(codexConfigFile(), `model = "x"\n${enabledPlugin()}\n${enabledPlugin("other", "false")}`);
    cachePlugin("tokmizer", "0.9.59", true);
    cachePlugin("other", "0.9.58", false);
    expect(codexPlugins()).toEqual([
      { id: "tokmizer@tokmizer", marketplace: "tokmizer", enabled: true, state: "hooked" },
      { id: "tokmizer@other", marketplace: "other", enabled: false, state: "legacy" }
    ]);
    expect(codexPluginProvidesHook()).toBe(true);
    expect(codexHookInstalled()).toBe(true);
  });

  it("does not count an old plugin as the Codex hook", () => {
    writeFileSync(codexConfigFile(), enabledPlugin());
    cachePlugin("tokmizer", "0.9.58", false);
    expect(codexPluginProvidesHook()).toBe(false);
    expect(codexHookInstalled()).toBe(false);
    expect(codexFindings()).toEqual([{ kind: "legacy-plugin", file: codexConfigFile(), ids: ["tokmizer@tokmizer"] }]);
  });

  it("judges the plugin by its newest cached version", () => {
    writeFileSync(codexConfigFile(), enabledPlugin());
    cachePlugin("tokmizer", "0.9.58", false);
    cachePlugin("tokmizer", "0.9.100", true);
    expect(codexPlugins()[0]!.state).toBe("hooked");
    expect(codexFindings()).toEqual([]);
    cachePlugin("tokmizer", "0.10.0", false);
    expect(codexPlugins()[0]!.state).toBe("legacy");
  });

  it("reads and turns off inline plugin entries", () => {
    const text = `[plugins]\n"tokmizer@a" = { enabled = true }\n"github@openai" = { enabled = true }\n\n[x]\nplugins."tokmizer@b" = {}\n`;
    expect(codexPlugins(text).map((p) => [p.id, p.enabled])).toEqual([["tokmizer@a", true]]);
    expect(disableLegacyPlugins(text, ["tokmizer@a"])).toBe(text.replace(`"tokmizer@a" = { enabled = true }`, `"tokmizer@a" = { enabled = false }`));
    const top = `plugins."tokmizer@b" = {}\n[other]\n`;
    expect(codexPlugins(top).map((p) => p.id)).toEqual(["tokmizer@b"]);
    expect(disableLegacyPlugins(top, ["tokmizer@b"])).toBe(`plugins."tokmizer@b" = { enabled = false }\n[other]\n`);
  });

  it("turns off an old plugin in place", () => {
    const text = `# mine\n[plugins."tokmizer@tokmizer"]\nenabled = true # on\n\n[plugins.'tokmizer@b']\n[other]\nx = 1`;
    expect(disableLegacyPlugins(text, ["tokmizer@tokmizer", "tokmizer@b"])).toBe(`# mine\n[plugins."tokmizer@tokmizer"]\nenabled = false\n\n[plugins.'tokmizer@b']\nenabled = false\n[other]\nx = 1`);
  });
});

const CODEX_HOOK = "node '/x/dist/bin/tkr-codex-hook.js'";

describe("setupCodexHook and doctor", () => {
  it("removes imported Claude hooks with a backup and installs the Codex hook", async () => {
    const imported = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: CLAUDE_FORMS[0], timeout: 5 }] }], Stop: [{ hooks: [{ type: "command", command: "mine.sh" }] }] } };
    writeFileSync(codexHooksFile(), JSON.stringify(imported));
    expect(codexDoctorLines()).toEqual([expect.stringContaining("1 Tokmizer hook made for another agent (copied or imported")]);
    const lines = await codexDoctorFix(CODEX_HOOK);
    expect(lines).toEqual([
      expect.stringContaining("Removed 1 Tokmizer hook made for another agent"),
      `Added the Codex hook in ${codexHooksFile()}.`,
      "In Codex, run /hooks once, approve the Tokmizer hook, then restart Codex."
    ]);
    expect(JSON.parse(readFileSync(codexHooksFile(), "utf8")).hooks).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: CODEX_HOOK, timeout: 10 }] }],
      Stop: [{ hooks: [{ type: "command", command: "mine.sh" }] }]
    });
    expect(JSON.parse(readFileSync(configBackupFile(codexHooksFile()), "utf8"))).toEqual(imported);
    expect(codexDoctorLines()).toEqual([]);
    expect(await codexDoctorFix(CODEX_HOOK)).toEqual([]);
  });

  it("cleans config.toml imports and an old plugin, keeping the rest of the file", async () => {
    const toml = `model = "gpt-5.5"\n\n${enabledPlugin()}\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "'/p/tkr-exec' --pre-tool-use"\n`;
    writeFileSync(codexConfigFile(), toml);
    cachePlugin("tokmizer", "0.9.58", false);
    expect(codexDoctorLines()).toHaveLength(2);
    await codexDoctorFix(CODEX_HOOK);
    expect(readFileSync(codexConfigFile(), "utf8")).toBe(`model = "gpt-5.5"\n\n[plugins."tokmizer@tokmizer"]\nenabled = false\n\n`);
    expect(readFileSync(configBackupFile(codexConfigFile()), "utf8")).toBe(toml);
    expect(JSON.parse(readFileSync(codexHooksFile(), "utf8")).hooks.PreToolUse[0].hooks[0].command).toBe(CODEX_HOOK);
    expect(codexDoctorLines()).toEqual([]);
  });

  it("does not add a second hook when the fixed Codex plugin already runs it", async () => {
    writeFileSync(codexConfigFile(), enabledPlugin());
    cachePlugin("tokmizer", "0.9.59", true);
    expect(await setupCodexHook(CODEX_HOOK)).toMatchObject({ hook: "plugin" });
    expect(existsSync(codexHooksFile())).toBe(false);
  });

  it("removes the hooks.json copy that duplicates the plugin hook", async () => {
    await ensureCodexHook(CODEX_HOOK);
    writeFileSync(codexConfigFile(), enabledPlugin());
    cachePlugin("tokmizer", "0.9.59", true);
    expect(codexDoctorLines()).toEqual([expect.stringContaining("both run the Tokmizer hook")]);
    expect(await codexDoctorFix(CODEX_HOOK)).toEqual([`Removed the extra Tokmizer hook from ${codexHooksFile()}: the Tokmizer Codex plugin already runs it.`]);
    expect(JSON.parse(readFileSync(codexHooksFile(), "utf8")).hooks).toEqual({});
    expect(codexDoctorLines()).toEqual([]);
  });

  it("also replaces a hook copied from another agent than Claude Code", async () => {
    writeFileSync(codexHooksFile(), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/p/tkr' hook cursor" }] }] } }));
    await codexDoctorFix(CODEX_HOOK);
    expect(JSON.parse(readFileSync(codexHooksFile(), "utf8")).hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: CODEX_HOOK, timeout: 10 }] }]);
  });

  it("finds and cleans project-level .codex hooks up to the repository root", async () => {
    const repo = join(dir, "repo");
    const sub = join(repo, "a", "b");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".codex"), { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(repo, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: CLAUDE_FORMS[0] }, { type: "command", command: "lint.sh" }] }] } }));
    writeFileSync(join(repo, ".codex", "config.toml"), "[[hooks.PostToolUse]]\n[[hooks.PostToolUse.hooks]]\ncommand = \"'/p/tkr-exec' --post-tool-use\"\n");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: CLAUDE_FORMS[1] }] }] } }));
    expect(codexFindings(sub)).toEqual([]);
    expect(codexFindings(sub, true).map((f) => f.file)).toEqual([join(repo, ".codex", "hooks.json"), join(repo, ".codex", "config.toml")]);
    const { repairCodexConfig } = await import("../codex-repair");
    await repairCodexConfig(codexFindings(sub, true));
    expect(JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks).toEqual([{ type: "command", command: "lint.sh" }]);
    expect(readFileSync(join(repo, ".codex", "config.toml"), "utf8")).toBe("");
    expect(codexFindings(sub, true)).toEqual([]);
  });

  it("leaves a user without any Codex config untouched", async () => {
    expect(codexDoctorLines()).toEqual([]);
    expect(await codexDoctorFix(CODEX_HOOK)).toEqual([]);
    expect(existsSync(codexHooksFile())).toBe(false);
  });

  it("refuses to rewrite an unreadable hooks.json", async () => {
    writeFileSync(codexHooksFile(), `{ "hooks": { "PreToolUse": [ ${JSON.stringify(CLAUDE_FORMS[0])}`);
    expect(codexDoctorLines()).toEqual([]);
    expect((await setupCodexHook(CODEX_HOOK)).hook).toBe("error");
  });
});
