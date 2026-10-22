import { describe, expect, it } from "vitest";
import { installChannelOf } from "../install-channel";

describe("installChannelOf", () => {
  it("reads the channel from where the plugin runs", () => {
    expect(installChannelOf("/u/.claude/plugins/cache/tokmizer/tokmizer/1.1.1/dist/bin/tkr.js", false)).toBe("claude-code");
    expect(installChannelOf("C:\\u\\.claude\\plugins\\cache\\tokmizer\\tokmizer\\1.1.1\\dist\\bin\\tkr.js", false)).toBe("claude-code");
    expect(installChannelOf("/u/.codex/plugins/cache/tokmizer/tokmizer/1.1.1/dist/bin/tkr.js", false)).toBe("codex");
    expect(installChannelOf("/u/.npm/_npx/1a2b/node_modules/@tokmizer/plugin/dist/bin/tkr.js", false)).toBe("npx");
    expect(installChannelOf("/opt/homebrew/Cellar/tokmizer/1.1.1/libexec/lib/node_modules/@tokmizer/plugin/dist/bin/tkr.js", false)).toBe("homebrew");
    expect(installChannelOf("/srv/linuxbrew/.linuxbrew/lib/node_modules/@tokmizer/plugin/dist/bin/tkr.js", false)).toBe("homebrew");
    expect(installChannelOf("/usr/local/lib/node_modules/@tokmizer/plugin/dist/bin/tkr.js", false)).toBe("npm");
    expect(installChannelOf("/usr/local/lib/node_modules/@tokmizer/plugin-darwin-arm64/tkr", true)).toBe("npm");
    expect(installChannelOf("/u/.tokmizer/bin/tkr", true)).toBe("script");
  });

  it("sends nothing when the place is not recognized", () => {
    expect(installChannelOf("/u/src/tokmizer/packages/plugin/dist/bin/tkr.js", false)).toBeNull();
    expect(installChannelOf("", false)).toBeNull();
  });

  it("never returns the path itself or a user name", () => {
    expect(installChannelOf("/u/alice-secret/.claude/plugins/x", false)).toBe("claude-code");
  });
});
