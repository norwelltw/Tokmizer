import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const shippedScript = resolve("packages/plugin/scripts/install-mac-linux.sh");
const single = process.env.TOKMIZER_SINGLE_TEST_BIN;
const native = process.env.TOKMIZER_NATIVE_TEST_BIN;
const key = `${process.platform}-${process.arch}`;
let root: string;
let home: string;
let release: string;
let script: string;
let releaseKey: KeyObject;
let releasePublic: KeyObject;

function sshString(b: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

function sshKeyBlob(key: KeyObject): Buffer {
  return Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.from(key.export({ format: "jwk" }).x!, "base64url"))]);
}

function signSums(key: KeyObject) {
  const data = readFileSync(join(release, "SHA256SUMS"));
  writeFileSync(join(release, "SHA256SUMS.sig"), sign(null, data, key));
  const ns = "tokmizer-release";
  const tbs = Buffer.concat([Buffer.from("SSHSIG"), sshString(ns), sshString(""), sshString("sha512"), sshString(createHash("sha512").update(data).digest())]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([
    Buffer.from("SSHSIG"),
    version,
    sshString(sshKeyBlob(createPublicKey(key))),
    sshString(ns),
    sshString(""),
    sshString("sha512"),
    sshString(Buffer.concat([sshString("ssh-ed25519"), sshString(sign(null, tbs, key))]))
  ]);
  const armored = blob.toString("base64").match(/.{1,70}/g)!.join("\n");
  writeFileSync(join(release, "SHA256SUMS.sshsig"), `-----BEGIN SSH SIGNATURE-----\n${armored}\n-----END SSH SIGNATURE-----\n`);
}

function patchScript(publicKey: KeyObject): string {
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const ssh = `ssh-ed25519 ${sshKeyBlob(publicKey).toString("base64")}`;
  const text = readFileSync(shippedScript, "utf8")
    .replace(/^RELEASE_KEY_PEM='[^']*'$/m, () => `RELEASE_KEY_PEM='${pem}'`)
    .replace(/^RELEASE_KEY_SSH='[^']*'$/m, () => `RELEASE_KEY_SSH='${ssh}'`);
  const out = join(root, "install.sh");
  writeFileSync(out, text);
  return out;
}

function toolbox(extra: Record<string, string> = {}): string {
  const dir = join(root, "toolbox");
  mkdirSync(dir, { recursive: true });
  for (const name of ["uname", "curl", "tar", "gzip", "mktemp", "rm", "grep", "head", "sha256sum", "shasum", "cut", "mkdir", "mv", "ln", "cat", "sh", "env", "perl"]) {
    const found = ["/usr/bin", "/bin"].map((d) => join(d, name)).find((p) => existsSync(p));
    if (found && !existsSync(join(dir, name))) symlinkSync(found, join(dir, name));
  }
  for (const [name, target] of Object.entries(extra)) symlinkSync(target, join(dir, name));
  return dir;
}

function capableOpenssl(): string | undefined {
  for (const candidate of ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl", "/usr/bin/openssl"]) {
    if (!existsSync(candidate)) continue;
    const help = spawnSync(candidate, ["pkeyutl", "-help"], { encoding: "utf8" });
    if (`${help.stdout}${help.stderr}`.includes("-rawin")) return candidate;
  }
  return undefined;
}

const stub = (log: string) => `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1" = "--single-check" ] && printf 'tokmizer-single 9.9.9\\n'\nexit 0\n`;

function publish(tkr: string, exec: string) {
  const name = `tokmizer-9.9.9-${key}`;
  const stage = join(root, "stage");
  mkdirSync(join(stage, name, "dist", "bin"), { recursive: true });
  copyFileSync(tkr, join(stage, name, "dist", "bin", "tkr"));
  copyFileSync(exec, join(stage, name, "dist", "bin", "tkr-exec"));
  chmodSync(join(stage, name, "dist", "bin", "tkr"), 0o755);
  chmodSync(join(stage, name, "dist", "bin", "tkr-exec"), 0o755);
  const archive = join(release, `${name}.tar.gz`);
  const packed = spawnSync("tar", ["-czf", archive, "-C", stage, name]);
  expect(packed.status).toBe(0);
  const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(release, "SHA256SUMS"), `${sum}  ${name}.tar.gz\n`);
  signSums(releaseKey);
}

function install(extra: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [script], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      TOKMIZER_HOME: join(home, ".tokmizer"),
      TOKMIZER_STANDALONE: "1",
      TOKMIZER_DOWNLOAD_BASE: `file://${release}`,
      TOKMIZER_BASE_URL: "http://127.0.0.1:9",
      TOKMIZER_AUTO_UPDATE: "0",
      TOKMIZER_NETWORK: "off",
      ...extra
    }
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-standalone-install-")));
  home = join(root, "home");
  release = join(root, "release");
  mkdirSync(home);
  mkdirSync(release);
  const pair = generateKeyPairSync("ed25519");
  releaseKey = pair.privateKey;
  releasePublic = pair.publicKey;
  script = patchScript(releasePublic);
});

afterEach(() => {
  const run = join(home, ".tokmizer", "run");
  if (existsSync(run)) {
    for (const name of readdirSync(run).filter((n) => n.endsWith(".pid"))) {
      try {
        process.kill(Number(readFileSync(join(run, name), "utf8")), "SIGTERM");
      } catch {}
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32" || !["darwin", "linux"].includes(process.platform))("standalone installer and Claude Code", () => {
  it("adds the Claude Code hooks when Claude Code is installed", () => {
    const log = join(root, "calls");
    writeFileSync(join(root, "tkr"), stub(log));
    publish(join(root, "tkr"), join(root, "tkr"));
    mkdirSync(join(home, ".claude"));
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, "utf8").split("\n")).toEqual(expect.arrayContaining(["shim install", "setup-claude"]));
  });

  it("leaves Claude Code alone when it is not installed", () => {
    const log = join(root, "calls");
    writeFileSync(join(root, "tkr"), stub(log));
    publish(join(root, "tkr"), join(root, "tkr"));
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("shim install");
    expect(readFileSync(log, "utf8")).not.toContain("setup-claude");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("verifies the release signature before trusting SHA256SUMS", () => {
    writeFileSync(join(root, "tkr"), stub(join(root, "calls")));
    publish(join(root, "tkr"), join(root, "tkr"));
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Release signature verified \((openssl|ssh-keygen)\)/);
  });

  it("refuses SHA256SUMS changed after signing", () => {
    writeFileSync(join(root, "tkr"), stub(join(root, "calls")));
    publish(join(root, "tkr"), join(root, "tkr"));
    writeFileSync(join(release, "SHA256SUMS"), readFileSync(join(release, "SHA256SUMS"), "utf8") + "\n");
    const result = install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Release signature check failed/);
    expect(existsSync(join(root, "calls"))).toBe(false);
  });

  it("refuses a release signed by another key", () => {
    writeFileSync(join(root, "tkr"), stub(join(root, "calls")));
    publish(join(root, "tkr"), join(root, "tkr"));
    signSums(generateKeyPairSync("ed25519").privateKey);
    const result = install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Release signature check failed/);
  });

  it("refuses an unsigned release when a verifier is available", () => {
    writeFileSync(join(root, "tkr"), stub(join(root, "calls")));
    publish(join(root, "tkr"), join(root, "tkr"));
    rmSync(join(release, "SHA256SUMS.sig"));
    rmSync(join(release, "SHA256SUMS.sshsig"));
    const result = install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/release is not signed/);
  });

  it("warns without a verifier, and refuses with TOKMIZER_REQUIRE_SIG=1", () => {
    writeFileSync(join(root, "tkr"), stub(join(root, "calls")));
    publish(join(root, "tkr"), join(root, "tkr"));
    const path = toolbox();
    const warned = install({ PATH: path });
    expect(warned.status, warned.stderr).toBe(0);
    expect(`${warned.stdout}${warned.stderr}`).toMatch(/cannot verify the release signature/);
    const refused = install({ PATH: path, TOKMIZER_REQUIRE_SIG: "1" });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/TOKMIZER_REQUIRE_SIG/);
  });

  it.skipIf(!capableOpenssl())("uses openssl when it supports Ed25519", () => {
    writeFileSync(join(root, "tkr"), stub(join(root, "calls")));
    publish(join(root, "tkr"), join(root, "tkr"));
    const path = toolbox({ openssl: capableOpenssl()! });
    const ok = install({ PATH: path });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("Release signature verified (openssl)");
    writeFileSync(join(release, "SHA256SUMS.sig"), Buffer.alloc(64));
    const bad = install({ PATH: path });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/Release signature check failed/);
  });

  it.skipIf(!existsSync("/usr/bin/ssh-keygen"))("falls back to ssh-keygen when openssl lacks Ed25519", () => {
    writeFileSync(join(root, "tkr"), stub(join(root, "calls")));
    publish(join(root, "tkr"), join(root, "tkr"));
    const fake = join(root, "old-openssl");
    writeFileSync(fake, "#!/bin/sh\necho 'unsupported algorithm' >&2\nexit 1\n");
    chmodSync(fake, 0o755);
    const path = toolbox({ openssl: fake, "ssh-keygen": "/usr/bin/ssh-keygen" });
    const ok = install({ PATH: path });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("Release signature verified (ssh-keygen)");
  });

  it.skipIf(!single || !native)("installs working Node-free Claude Code hooks from the real standalone build", () => {
    publish(single!, native!);
    mkdirSync(join(home, ".claude"));
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    const bin = join(home, ".local", "bin");
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const pre = settings.hooks.PreToolUse.flatMap((g: { hooks: { command: string }[] }) => g.hooks).map((h: { command: string }) => h.command);
    expect(pre).toEqual([`[ ! -x '${join(bin, "tkr-exec")}' ] || exec '${join(bin, "tkr-exec")}' --pre-tool-use`]);
    expect(JSON.stringify(settings.hooks)).not.toMatch(/\bnode\b/);
    const hook = spawnSync("/bin/sh", ["-c", pre[0]], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command: "git status" } }),
      encoding: "utf8",
      timeout: 20000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TOKMIZER_HOME: join(home, ".tokmizer"), TOKMIZER_NETWORK: "off", TOKMIZER_AUTO_UPDATE: "0" }
    });
    expect(hook.status, hook.stderr).toBe(0);
    expect(JSON.parse(hook.stdout).hookSpecificOutput.updatedInput.command).toMatch(/ git status$/);
  }, 60000);
});
