import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDefaultRules, FILTERS_DIR } from "../default-rules-build";
import { defaultRulesRuntime, DEFAULT_RULES_SECRET, resolveAllowedFilters } from "../default-rules";
import { decryptBundle, encryptBundle } from "../bundle-crypto";
import { slugKey } from "../contracts";
import { __resetCache, readFilterDir } from "../engine/loader";
import { __resetMatcherCache } from "../engine/matcher";
import { saveBundleCache, bundleCachePath } from "../daemon/bundle-cache";

let sealed: string;
let payload: { bundleVersion: number; signedAt: number; filters: Record<string, unknown>[] };
let home: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["TOKMIZER_HOME", "TOKMIZER_DEV", "TOKMIZER_DEFAULT_RULES", "TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM", "TOKMIZER_TKR_BIN"];

beforeAll(async () => {
  sealed = await buildDefaultRules();
  payload = JSON.parse(decryptBundle(sealed, DEFAULT_RULES_SECRET));
});

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), "tkr-default-rules-"));
  process.env.TOKMIZER_HOME = home;
  process.env.TOKMIZER_TKR_BIN = join(home, "missing-tkr.js");
  delete process.env.TOKMIZER_DEV;
  process.env.TOKMIZER_DEFAULT_RULES = sealed;
  __resetCache();
  __resetMatcherCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
  __resetCache();
  __resetMatcherCache();
});

describe("built-in default rules bundle", () => {
  it("holds the full on-disk catalogue, without descriptions", async () => {
    const slugs = payload.filters.map((f) => f.slug as string);
    const onDisk = [...(await readFilterDir(FILTERS_DIR)).keys()];
    expect(slugs.length).toBeGreaterThan(100);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual([...onDisk].sort());
    for (const slug of ["cat", "git-log", "grep", "read-tool", "bash-tool", "terraform", "gcloud", "helm", "ansible-playbook"]) expect(slugs).toContain(slug);
    for (const f of payload.filters) expect(f).not.toHaveProperty("description");
    expect(typeof payload.bundleVersion).toBe("number");
  });

  it("compiles into a runtime that routes representative commands", () => {
    const rt = defaultRulesRuntime();
    expect(rt).not.toBeNull();
    expect(rt!.ruleCount).toBe(payload.filters.length);
    expect(rt!.selectFor("cat big.ts", "free")?.slug).toBe("cat");
    expect(rt!.selectFor("git log -n 300", "free")?.slug).toBe("git-log");
    expect(rt!.selectFor("rg import src", "free")?.slug).toBe("grep");
    expect(rt!.selectFor("terraform plan", "free")?.slug).toBe("tofu-plan");
    expect(rt!.selectFor("terraform apply", "free")?.slug).toBe("terraform");
    expect(rt!.selectFor("gcloud compute instances list", "free")?.slug).toBe("gcloud");
    expect(rt!.selectFor("ansible-playbook site.yml", "free")?.slug).toBe("ansible-playbook");
  });

  it("allows the whole embedded catalogue when the account sent no filter list", () => {
    const all = new Set(payload.filters.map((f) => slugKey(f.slug as string)));
    expect(resolveAllowedFilters(undefined)).toEqual(all);
    expect(resolveAllowedFilters([])).toEqual(all);
    expect(resolveAllowedFilters(["git"], true)).toEqual(all);
    expect(resolveAllowedFilters(["git"])).toEqual(new Set([slugKey("git")]));
    delete process.env.TOKMIZER_DEFAULT_RULES;
    expect(resolveAllowedFilters(undefined)).toBeNull();
    expect(resolveAllowedFilters(["git"])).toEqual(new Set([slugKey("git")]));
  });

  it("is unavailable when nothing is embedded", () => {
    delete process.env.TOKMIZER_DEFAULT_RULES;
    expect(defaultRulesRuntime()).toBeNull();
  });

  it("rejects a tampered or foreign blob", () => {
    process.env.TOKMIZER_DEFAULT_RULES = sealed.slice(0, -4) + "AAAA";
    expect(defaultRulesRuntime()).toBeNull();
    process.env.TOKMIZER_DEFAULT_RULES = encryptBundle(JSON.stringify(payload), "another-key");
    expect(defaultRulesRuntime()).toBeNull();
  });
});

describe("fresh install without network", () => {
  it("compresses through the exec wrapper with no state.json and no server", async () => {
    const { processCapturedOutput } = await import("../exec/wrapper");
    const stdout = Array.from({ length: 1500 }, (_, i) => `const line${i} = ${i};`).join("\n") + "\n";
    let missing = 0;
    const result = await processCapturedOutput(
      { argv: ["cat", "big.ts"], stdout, stderr: "", exitCode: 0, truncated: false, stderrTruncated: false },
      { yolo: false, env: {}, onMissingState: () => { missing += 1; } }
    );
    expect(missing).toBe(1);
    expect(result.filterId).toBe("cat");
    expect(result.filteredBytes).toBeLessThan(result.rawBytes / 2);
  });

  it("passes output through untouched when no rules are embedded", async () => {
    delete process.env.TOKMIZER_DEFAULT_RULES;
    const { processCapturedOutput } = await import("../exec/wrapper");
    const stdout = "x\n".repeat(2000);
    const result = await processCapturedOutput(
      { argv: ["cat", "big.ts"], stdout, stderr: "", exitCode: 0, truncated: false, stderrTruncated: false },
      { yolo: false, env: {}, onMissingState: () => {} }
    );
    expect(result.filterId).toBeNull();
    expect(result.stdout).toBe(stdout);
  });
});

describe("server bundle precedence", () => {
  it("prefers the cached server bundle and only falls back to built-in rules without one", async () => {
    const pair = generateKeyPairSync("ed25519");
    process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    process.env.TOKMIZER_DEV = "1";
    const serverPayload = encryptBundle(
      JSON.stringify({
        bundleVersion: 9,
        signedAt: Date.now(),
        filters: [{ slug: "npm", match_command: "^npm(?:\\s|$)", priority: 50, strip_ansi: false, strip_lines_matching: [], max_lines: 40 }]
      }),
      "sec"
    );
    saveBundleCache({
      payload: serverPayload,
      signature: sign(null, Buffer.from(serverPayload, "utf8"), pair.privateKey).toString("base64url"),
      enc: "v1"
    });
    vi.resetModules();
    vi.doMock("../daemon/client", () => ({
      connectDaemon: vi.fn().mockRejectedValue(new Error("no daemon"))
    }));
    vi.doMock("../state", () => ({
      loadState: vi.fn().mockResolvedValue({ jwt: "jwt", signingSecret: "sec", token: "tok_x" })
    }));
    const { installDaemonResolver, closeDaemonResolver } = await import("../daemon/resolver");
    const engine = await import("../engine");
    try {
      installDaemonResolver();
      const lines = "line\n".repeat(300);
      expect((await engine.processOutput("npm install", lines, null, { exitCode: 0 })).filterId).toBe("npm");
      expect((await engine.processOutput("git log", lines, null, { exitCode: 0 })).filterId).toBeNull();
      closeDaemonResolver();
      rmSync(bundleCachePath(), { force: true });
      installDaemonResolver();
      expect((await engine.processOutput("git log", lines, null, { exitCode: 0 })).filterId).toBe("git-log");
      expect((await engine.processOutput("npm install", lines, null, { exitCode: 0 })).filterId).toBe("npm");
    } finally {
      closeDaemonResolver();
      engine.setFilterResolver(null);
      vi.doUnmock("../daemon/client");
      vi.doUnmock("../state");
      vi.resetModules();
    }
  });
});
