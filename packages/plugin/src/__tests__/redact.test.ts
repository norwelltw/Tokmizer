import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactCommand } from "../learn/redact";

describe("redactCommand", () => {
  it("redacts bearer tokens in -H Authorization", () => {
    const r = redactCommand('curl -H "Authorization: Bearer eyJhbGciOiJI..." https://x');
    expect(r).not.toContain("eyJhbGciOiJI");
    expect(r).toContain("[REDACTED]");
  });

  it("redacts --password=value", () => {
    expect(redactCommand("mysql --password=Secr3t! -u root")).toContain("[REDACTED]");
  });

  it("redacts --token foo", () => {
    expect(redactCommand("gh auth login --token abc123def456")).toContain("[REDACTED]");
  });

  it("redacts URL-embedded creds", () => {
    expect(redactCommand("git push https://user:pwd@host.com/repo")).toContain("[REDACTED]@");
  });

  it("redacts AWS env-style", () => {
    expect(redactCommand("AWS_SECRET_ACCESS_KEY=abcdef ./run")).toContain("[REDACTED]");
  });

  it("redacts Stripe live key", () => {
    expect(redactCommand("export STRIPE=sk_live_abcdefghijklmnop")).toContain("sk_[REDACTED]");
  });

  it("redacts GitHub personal token", () => {
    expect(redactCommand("export GH=ghp_abcdefghijklmnopqrst")).toContain("ghp_[REDACTED]");
  });

  it("redacts long base64-looking values after =", () => {
    const long = "x".repeat(50);
    expect(redactCommand(`export FOO=${long}`)).toContain("[REDACTED]");
  });

  it("leaves benign commands unchanged", () => {
    expect(redactCommand("git status")).toBe("git status");
    expect(redactCommand("ls -la")).toBe("ls -la");
  });

  it("handles Basic auth", () => {
    expect(redactCommand("curl -H 'Authorization: Basic dXNlcjpwYXNz'")).toContain(
      "[REDACTED]"
    );
  });

  it("redacts curl -u user:pass", () => {
    expect(redactCommand("curl -u alice:mypassword https://api.example.com")).toContain(
      "[REDACTED]"
    );
    expect(redactCommand("curl --user bob:s3cret https://x")).toContain("[REDACTED]");
  });

  it("redacts ssh -i keypath", () => {
    expect(redactCommand("ssh -i /home/me/.ssh/id_ed25519 user@host")).toContain("[REDACTED]");
    expect(redactCommand("ssh -i ~/keys/prod.pem user@x")).toContain("[REDACTED]");
  });

  it("redacts OPENAI and ANTHROPIC env assignments", () => {
    expect(redactCommand("OPENAI_API_KEY=secret123 node run.js")).toContain("[REDACTED]");
    expect(redactCommand("ANTHROPIC_API_KEY=sk-ant-abc123 ./run")).toContain("[REDACTED]");
  });

  it("redacts JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36";
    expect(redactCommand(`curl -H "x-jwt: ${jwt}"`)).toContain("[REDACTED_JWT]");
  });

  it("redacts PEM private key blocks", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
abcdef
ghijkl
-----END RSA PRIVATE KEY-----`;
    expect(redactCommand(`echo "${pem}"`)).toContain("[REDACTED_PEM]");
  });

  it("redacts GitHub OAuth + GitLab PAT + Slack token", () => {
    expect(redactCommand("export GH=gho_abcdefghijklmnopqrst")).toContain("gho_[REDACTED]");
    expect(redactCommand("glab auth login --token glpat-abcdefghijklmnopqrst")).toContain(
      "[REDACTED]"
    );
    expect(redactCommand("export SLACK=xoxb-1234567890-abcdefg")).toContain("xox[REDACTED]");
  });

  it("redacts AWS SESSION_TOKEN and GOOGLE_APPLICATION_CREDENTIALS", () => {
    expect(redactCommand("AWS_SESSION_TOKEN=abc123 ./run")).toContain("[REDACTED]");
    expect(redactCommand("GOOGLE_APPLICATION_CREDENTIALS=/etc/gcp.json ./run")).toContain(
      "[REDACTED]"
    );
  });

  it("redacts all GitHub token prefixes including fine-grained", () => {
    expect(redactCommand("echo ghs_abcdefghijklmnopqrst")).toContain("ghs_[REDACTED]");
    expect(redactCommand("echo ghu_abcdefghijklmnopqrst")).toContain("ghu_[REDACTED]");
    expect(redactCommand("echo ghr_abcdefghijklmnopqrst")).toContain("ghr_[REDACTED]");
    expect(redactCommand("gh auth login --with-token <<< github_pat_" + "a1B2".repeat(20))).toContain(
      "github_pat_[REDACTED]"
    );
  });

  it("redacts the GitLab token family beyond glpat", () => {
    expect(redactCommand("echo glrt-abcdefghijklmnop")).toContain("glrt-[REDACTED]");
    expect(redactCommand("echo glsoat-abcdefghijklmnop")).toContain("glsoat-[REDACTED]");
    expect(redactCommand("echo gldt-abcdefghijklmnop")).toContain("gldt-[REDACTED]");
    expect(redactCommand("echo glimt-abcdefghijklmnop")).toContain("glimt-[REDACTED]");
    expect(redactCommand("echo gloas-abcdefghijklmnop")).toContain("gloas-[REDACTED]");
  });

  it("does not catastrophically backtrack on a pathological URL-credential input", () => {
    const pathological = "a.".repeat(20000) + "://u:p";
    const t0 = Date.now();
    redactCommand(pathological);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("still redacts real URL-embedded credentials", () => {
    const r = redactCommand("git clone http://alice:s3cr3tpw@github.com/x/y.git");
    expect(r).not.toContain("s3cr3tpw");
    expect(r).toContain("[REDACTED]@");
  });

  it("does not catastrophically backtrack on a pathological hyphenated-header input", () => {
    const pathological = "a-".repeat(20000) + "!";
    const t0 = Date.now();
    redactCommand(pathological);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("still redacts custom -Token / -Key / X-Api-Key headers", () => {
    expect(redactCommand("curl -H 'X-Api-Key: abc123secret'")).toContain("[REDACTED]");
    expect(redactCommand("curl -H 'X-Custom-Auth-Token: zzz999'")).toContain("[REDACTED]");
  });

  it("redacts bare credential shapes without labeled context", () => {
    expect(redactCommand("aws configure set key AKIAIOSFODNN7EXAMPLE")).toContain(
      "[REDACTED_AWS_KEY]"
    );
    expect(redactCommand("railway up AIzaSy" + "Dabc".repeat(8) + "x")).toContain(
      "[REDACTED_GOOGLE_KEY]"
    );
    expect(redactCommand("vault login hvs." + "a1B2".repeat(6))).toContain(
      "[REDACTED_VAULT_TOKEN]"
    );
  });
});

describe("cross-implementation redaction parity", () => {
  interface ParityProbe {
    cmd: string;
    secret: string;
  }
  const parity = JSON.parse(
    readFileSync(join(process.cwd(), "probes", "redaction-parity.json"), "utf8")
  ) as { probes: ParityProbe[] };

  it("loads the shared parity table", () => {
    expect(parity.probes.length).toBeGreaterThanOrEqual(15);
  });

  for (const probe of parity.probes) {
    it(`secret never survives npm redaction: ${probe.secret.slice(0, 16)}…`, () => {
      const out = redactCommand(probe.cmd);
      expect(out).not.toContain(probe.secret);
      expect(redactCommand(out)).toBe(out);
    });
  }
});
