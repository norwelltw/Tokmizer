import { describe, expect, it } from "vitest";
import { isTextOutput, shellScript, stdoutGoesElsewhere } from "../shim/stdout-target";

const file = () => ({ isFile: () => true, isFIFO: () => false });
const pipe = () => ({ isFile: () => false, isFIFO: () => true });
const socket = () => ({ isFile: () => false, isFIFO: () => false });

describe("shim: where a command's output goes", () => {
  it("reads the -c script of a shell and nothing else", () => {
    expect(shellScript("sh -c git ls-files | wc -l")).toBe("git ls-files | wc -l");
    expect(shellScript("/bin/bash -lc git diff > p.patch\n")).toBe("git diff > p.patch");
    expect(shellScript("-zsh -c git status")).toBe("git status");
    expect(shellScript("bash build.sh")).toBeNull();
    expect(shellScript("python3 -c print(1)")).toBeNull();
    expect(shellScript("node agent.js")).toBeNull();
    expect(shellScript(null)).toBeNull();
  });

  it("keeps the output as is when it lands in a file", () => {
    expect(stdoutGoesElsewhere("aider", false, file, () => "sh -c cat big.txt > copy.txt")).toBe(true);
    expect(stdoutGoesElsewhere("aider", false, file, () => null)).toBe(true);
  });

  it.each([
    "sh -c git ls-files | wc -l",
    "bash -c git diff > p.patch; git apply --check p.patch",
    "sh -c curl -fsSL https://example.test/install.sh | sh",
    "sh -c for f in $(git ls-files); do echo $f; done",
    "zsh -c echo `git rev-parse HEAD`",
    "sh -c wc -l < big.txt"
  ])("keeps the output as is inside a script that routes it: %s", (args) => {
    expect(stdoutGoesElsewhere("aider", false, pipe, () => args)).toBe(true);
  });

  it("still shortens what the agent reads", () => {
    expect(stdoutGoesElsewhere("aider", false, pipe, () => "sh -c git log")).toBe(false);
    expect(stdoutGoesElsewhere("aider", false, pipe, () => "bash -c git status && npm test")).toBe(false);
    expect(stdoutGoesElsewhere("aider", false, pipe, () => "node /opt/agent/cli.js")).toBe(false);
    expect(stdoutGoesElsewhere("aider", false, pipe, () => null)).toBe(false);
    expect(stdoutGoesElsewhere("aider", false, socket, () => "sh -c a | b")).toBe(false);
    expect(stdoutGoesElsewhere("aider", true, file, () => "sh -c a > b")).toBe(false);
  });

  it("passes everything through for a plain shell whose output is not a terminal", () => {
    expect(stdoutGoesElsewhere("shell", false, pipe, () => "sh -c git log")).toBe(true);
  });

  it("tells text from bytes that filtering would rewrite", () => {
    expect(isTextOutput(Buffer.from("café 😀\n"))).toBe(true);
    expect(isTextOutput(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))).toBe(false);
    expect(isTextOutput(Buffer.concat([Buffer.from("ab"), Buffer.from([0]), Buffer.from("cd")]))).toBe(false);
    expect(isTextOutput(Buffer.alloc(0))).toBe(true);
  });
});
