import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blockWithOutput, commandFor } from "../hooks-host/command-expansion";

describe("slash commands shown exactly as the CLI prints them", () => {
  it("maps read-only commands, plugin-namespaced or not", () => {
    expect(commandFor("tkr-gain", "")).toEqual(["gain"]);
    expect(commandFor("tokmizer:tkr-gain", "--week --by-rule")).toEqual(["gain", "--week", "--by-rule"]);
    expect(commandFor("tkr-status", "")).toEqual(["status"]);
    expect(commandFor("tkr-telemetry", "")).toEqual(["telemetry", "status"]);
    expect(commandFor("tkr-yolo", "status")).toEqual(["yolo", "status"]);
    expect(commandFor("tkr-compression", undefined)).toEqual(["compression"]);
  });

  it("leaves commands that change state, need a value or read prose to the model", () => {
    for (const [name, args] of [
      ["tkr-telemetry", "off"], ["tkr-yolo", "on"], ["tkr-compression", "max"], ["tkr-status", "please"],
      ["tkr-link", "tokmizer_key"], ["tkr-unlink", ""], ["tkr-update", ""], ["tkr", "show"], ["other", ""]
    ] as const) {
      expect(commandFor(name, args)).toBeNull();
    }
  });

  it("refuses arguments that are not plain words or flags", () => {
    expect(commandFor("tkr-gain", "--day; rm -rf ~")).toBeNull();
    expect(commandFor("tkr-gain", "$(whoami)")).toBeNull();
    expect(commandFor("tkr-gain", "`id`")).toBeNull();
    expect(commandFor(42, "")).toBeNull();
  });

  it("blocks the expansion with the output as the message", () => {
    expect(JSON.parse(blockWithOutput("  Tokmizer savings\n  line\n\n"))).toEqual({ decision: "block", reason: "  Tokmizer savings\n  line", hookSpecificOutput: { hookEventName: "UserPromptExpansion", suppressOriginalPrompt: true } });
  });

  it("is declared for Claude Code in the plugin hooks", () => {
    const hooks = JSON.parse(readFileSync(join(__dirname, "..", "..", "hooks", "hooks.json"), "utf8")).hooks;
    expect(hooks.UserPromptExpansion[0].hooks[0].command).toContain("dist/hooks-host/command-expansion.js");
  });
});
