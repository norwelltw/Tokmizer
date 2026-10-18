import { describe, expect, it } from "vitest";
import { commandName } from "../learn/telemetry";

describe("telemetry commandName — privacy sanitization", () => {
  it("keeps the bare command name", () => {
    expect(commandName("docker")).toBe("docker");
  });

  it("keeps a safe subcommand but nothing more", () => {
    expect(commandName("docker build -t app .")).toBe("docker build");
    expect(commandName("npm install left-pad")).toBe("npm install");
  });

  it("drops arguments, flags, values and paths", () => {
    expect(commandName("cat /home/me/.env")).toBe("cat");
    expect(commandName("curl https://api.example.com?token=abc")).toBe("curl");
    expect(commandName("psql --password=hunter2")).toBe("psql");
  });

  it("never leaks an arg as the second token", () => {
    expect(commandName("rm -rf /tmp/x")).toBe("rm");
    expect(commandName("node --inspect server.js")).toBe("node");
  });

  it("caps length and handles empty", () => {
    expect(commandName("")).toBe("");
    expect(commandName("   ")).toBe("");
    expect(commandName("a".repeat(200))).toBe("");
  });

  it("labels git and gh with a closed verb list and never their arguments", () => {
    expect(commandName("git status")).toBe("git status");
    expect(commandName("git push origin main")).toBe("git push");
    expect(commandName("git --no-pager log --oneline")).toBe("git log");
    expect(commandName("git -C /home/me/secret-repo diff HEAD~1")).toBe("git diff");
    expect(commandName("git -c user.token=abc show HEAD")).toBe("git show");
    expect(commandName("git my-secret-alias")).toBe("git");
    expect(commandName("git")).toBe("git");
    expect(commandName("GIT push")).toBe("git push");
    expect(commandName("/usr/bin/git status")).toBe("git status");
    expect(commandName("gh pr create --title x")).toBe("gh pr");
    expect(commandName("gh api repos/acme/private")).toBe("gh api");
    expect(commandName("gh auth login --with-token")).toBe("gh");
    expect(commandName("GITHUB_TOKEN=x gh pr list")).toBe("gh pr");
  });

  it("still never logs the other forge CLIs and git-prefixed tools", () => {
    expect(commandName("glab mr create --title x")).toBe("");
    expect(commandName("gup sync")).toBe("");
    expect(commandName("hub clone foo")).toBe("");
    expect(commandName("gist file.txt")).toBe("");
    expect(commandName("github-runner start")).toBe("");
    expect(commandName("gitlab-runner exec")).toBe("");
    expect(commandName("git-lfs pull")).toBe("");
  });

  it("skips leading env assignments", () => {
    expect(commandName("FOO=bar npm install")).toBe("npm install");
    expect(commandName("A=1 B=2 docker build")).toBe("docker build");
  });

  it("blocks the git family behind wrapper binaries", () => {
    expect(commandName("sudo git push")).toBe("");
    expect(commandName("env git status")).toBe("");
    expect(commandName("xargs gh repo list")).toBe("");
    expect(commandName("command glab mr list")).toBe("");
    expect(commandName("sudo docker build")).toBe("sudo");
  });

  it("resolves a pathed known tool to its basename and drops unknown paths", () => {
    expect(commandName("/usr/local/bin/node script.mjs")).toBe("node");
    expect(commandName("/usr/local/bin/docker compose up")).toBe("docker compose");
    expect(commandName("C:\\nodejs\\node.exe script.mjs")).toBe("node");
    expect(commandName("./deploy-internal.sh --run")).toBe("");
  });

  it("keeps the subcommand only for allowlisted verb CLIs", () => {
    expect(commandName("ssh prod-payments-db")).toBe("ssh");
    expect(commandName("psql analytics-replica")).toBe("psql");
    expect(commandName("kubectl get pods")).toBe("kubectl get");
    expect(commandName("deploy client-acme-staging")).toBe("deploy");
    expect(commandName("vault read-prod-secret")).toBe("vault");
  });

  it("blocks AWS principal and Vault token shapes as the command name", () => {
    expect(commandName("AROAEXAMPLEID1234567")).toBe("");
    expect(commandName("ASIAEXAMPLEID1234567")).toBe("");
    expect(commandName("hvs.abcdefghijklmnop")).toBe("");
    expect(commandName("hvb.abcdefghijklmnop")).toBe("");
  });

  it("returns empty when the first non-assignment token is unsafe", () => {
    expect(commandName("grep-tool: SECRET_PATTERN")).toBe("");
    expect(commandName("glob-tool: src/**/*.ts")).toBe("");
    expect(commandName("!!weird stuff")).toBe("");
  });

  it("never returns a bare credential as the command name", () => {
    expect(commandName("ghp_" + "a1B2".repeat(9))).toBe("");
    expect(commandName("github_pat_" + "a1B2".repeat(20))).toBe("");
    expect(commandName("glpat-" + "a1B2".repeat(6))).toBe("");
    expect(commandName("npm_" + "a1B2".repeat(9))).toBe("");
    expect(commandName("x".repeat(30))).toBe("");
    expect(commandName("x".repeat(30) + " --flag")).toBe("");
  });
});

describe("recordTelemetry — savings survive name redaction", () => {
  it("labels git with its verb, buckets never-logged bins as 'other' and keeps their savings", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "tkr-telem-"));
    const prev = process.env.TOKMIZER_HOME;
    process.env.TOKMIZER_HOME = home;
    try {
      const { recordTelemetry } = await import("../learn/telemetry");
      await recordTelemetry({ cmd: "git log --oneline secret-branch", tokensSaved: 1234, optimized: true, telemetryOptIn: true });
      await recordTelemetry({ cmd: "glab mr list", tokensSaved: 7, optimized: false, telemetryOptIn: true });
      await recordTelemetry({ cmd: "docker build -t app .", tokensSaved: 50, optimized: true, telemetryOptIn: true });
      const lines = readFileSync(join(home, "spool", "telemetry.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines[0]).toEqual({ cmd: "git log", tokensSaved: 1234, optimized: true });
      expect(lines[1]).toEqual({ cmd: "other", tokensSaved: 7, optimized: false });
      expect(lines[2].cmd).toBe("docker build");
      expect(lines.every((l) => !JSON.stringify(l).includes("secret-branch") && !JSON.stringify(l).includes("glab"))).toBe(true);
    } finally {
      process.env.TOKMIZER_HOME = prev;
    }
  });
});
