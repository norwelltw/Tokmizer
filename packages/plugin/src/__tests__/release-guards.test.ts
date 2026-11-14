import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lockWithoutPlatformPins } from "../../scripts/bundle-config.mjs";
import { comparePublished } from "../../scripts/check-published-singles.mjs";

const lock = (pluginVersion: string, platformVersion: string, lodash = "4.17.21") => JSON.stringify({
  name: "token",
  lockfileVersion: 3,
  packages: {
    "": { workspaces: ["packages/*"] },
    "packages/plugin": {
      name: "@tokmizer/plugin",
      version: pluginVersion,
      dependencies: { lodash: `^${lodash}` },
      optionalDependencies: { "@tokmizer/plugin-darwin-arm64": platformVersion, "@tokmizer/plugin-linux-x64": platformVersion }
    },
    "node_modules/@tokmizer/plugin": { resolved: "packages/plugin", link: true },
    "node_modules/@tokmizer/plugin-darwin-arm64": { version: platformVersion, optional: true },
    "node_modules/@tokmizer/plugin-linux-x64": { version: platformVersion, optional: true },
    "node_modules/lodash": { version: lodash }
  }
}, null, 2);

describe("source fingerprint of the lockfile", () => {
  it("ignores the platform package pins written by the lock commit of a release", () => {
    expect(lockWithoutPlatformPins(lock("1.1.5", "1.1.5"))).toBe(lockWithoutPlatformPins(lock("1.1.6", "1.1.6")));
  });

  it("still changes when another dependency changes", () => {
    expect(lockWithoutPlatformPins(lock("1.1.6", "1.1.6"))).not.toBe(lockWithoutPlatformPins(lock("1.1.6", "1.1.6", "4.17.22")));
  });

  it("keeps the workspace link of the plugin itself", () => {
    expect(JSON.parse(lockWithoutPlatformPins(lock("1.1.6", "1.1.6"))).packages["node_modules/@tokmizer/plugin"]).toEqual({ resolved: "packages/plugin", link: true });
  });
});

describe("published single binaries", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const entry = (key: string, text: string) => ({ version: "1.1.6", package: `@tokmizer/plugin-${key}`, file: "tkr", sha256: sha(text) });

  it("accepts a build whose pins match the binaries on npm", () => {
    const published: Record<string, string> = { "@tokmizer/plugin-darwin-arm64": "arm", "@tokmizer/plugin-linux-x64": "x64" };
    const manifest = { "darwin-arm64": entry("darwin-arm64", "arm"), "linux-x64": entry("linux-x64", "x64") };
    expect(comparePublished(manifest, (e) => Buffer.from(published[e.package]))).toEqual([]);
  });

  it("refuses a build that pins a rebuilt binary instead of the published one", () => {
    const manifest = { "darwin-arm64": entry("darwin-arm64", "rebuilt by the release check") };
    const [problem] = comparePublished(manifest, () => Buffer.from("published"));
    expect(problem).toBe(`darwin-arm64: the published tkr has sha256 ${sha("published")}, dist/native/single.json pins ${sha("rebuilt by the release check")}`);
  });

  it("refuses to publish before the platform packages are on npm", () => {
    expect(comparePublished({ "linux-x64": entry("linux-x64", "x64") }, () => null)).toEqual(["linux-x64: @tokmizer/plugin-linux-x64@1.1.6 is not on npm; publish the platform packages first"]);
  });
});
