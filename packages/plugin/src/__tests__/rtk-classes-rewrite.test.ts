import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewrite, rewriteShellDecision } from "../hooks-host/pre-tool-rewrite";

describe("long-running and watch commands stay unrewritten", () => {
  const cases = [
    "npm run dev", "npm start", "npm run start", "npm run dev -- --port 3000", "npm run dev:web", "pnpm dev", "pnpm run watch", "npm run-script dev", "npm --silent run dev", "pnpm --filter web dev", "yarn workspace web dev", "npm -w web run dev",
    "yarn dev", "yarn start", "bun dev", "bun run dev", "next dev", "npx next dev", "next start",
    "vite", "vite dev", "vite serve", "vite --port 5173", "npx vite", "./node_modules/.bin/vite",
    "vitest --watch", "vitest watch", "vitest dev", "vitest -w", "npx vitest --watch",
    "jest --watch", "jest --watchAll", "npx jest --watchAll",
    "tsc -w", "tsc --watch", "tsc -p . --watch", "npx tsc -w", "webpack --watch", "esbuild src/a.ts --watch", "node --watch app.js",
    "cargo watch", "cargo watch -x test", "nodemon", "nodemon app.js", "dotnet watch run",
    "docker compose up", "docker compose up web", "docker-compose up", "podman compose up",
    "docker logs -f web", "kubectl logs -f pod", "docker stats", "docker stats web",
    "kubectl get pods -w", "kubectl get pods --watch", "kubectl port-forward svc/a 8080:80",
    "ping host", "ping -i 2 host", "tail -F log", "tail -f log", "tail --follow log", "tail --follow=name log", "tail -n 20 -F log",
    "top", "htop", "watch git status", "watch -n 1 ls",
    "cd app && npm run dev", "git status && vite"
  ];
  for (const cmd of cases) {
    it(cmd, () => {
      expect(rewrite(cmd)).not.toContain(`tkr-exec ${cmd.split(" && ").pop()}`);
      if (!cmd.includes("&&")) expect(rewrite(cmd)).toBe(cmd);
    });
  }

  it("keeps the other segments of a chain rewritable", () => {
    expect(rewrite("git status && vite")).toBe("tkr-exec git status && vite");
    expect(rewrite("cd app && npm run dev")).toBe("cd app && npm run dev");
  });
});

describe("ordinary commands are still rewritten", () => {
  const cases = [
    "git diff", "cargo test", "cargo build", "npm test", "npm run build", "pnpm build", "vitest run", "vitest", "vitest --run",
    "vitest --watch=false", "jest", "tsc", "tsc --noEmit", "vite build", "next build", "tail -n 20 f", "docker compose up -d",
    "docker compose up --detach", "docker compose ps", "docker stats --no-stream", "docker logs web", "kubectl get pods",
    "ping -c 3 host", "git log -w", "grep -w foo f",
    "npm install serve", "npm i preview", "pnpm add vite", "yarn add dev-thing", "yarn add dev", "bun add start", "npm run build -- watch", "npm exec -- tsc", "yarn workspace web add serve", "pnpm --filter web add vite"
  ];
  for (const cmd of cases) it(cmd, () => expect(rewrite(cmd)).toBe(`tkr-exec ${cmd}`));
});

describe("redirected or piped compounds keep their inner commands", () => {
  const cases = [
    "{ git status; git diff; } > out.txt",
    "{ git status; git diff; } >> out.txt",
    "{ git status; git diff; } 2>&1 | tee out.txt",
    "{ git status; git diff; } | less",
    "( git status; git diff ) | cat",
    "(git status; git diff) > out.txt",
    "for f in a b; do git diff $f; done > f",
    "for f in a b; do git diff \"$f\"; done | cat",
    "while true; do git status; done | head -1",
    "until false; do git status; done > f",
    "if true; then git diff; else git status; fi > f",
    "if true; then git diff; fi | wc -l",
    "case x in x) git diff;; esac > f",
    "for f in a; do if true; then git diff; fi; done > f",
    "if true; then for f in a; do git diff; done; fi > f",
    "{ for f in a; do git diff; done; } > f",
    "git status; { git diff; cargo test; } > f"
  ];
  for (const cmd of cases) {
    it(cmd, () => {
      const out = rewrite(cmd);
      const close = Math.max(...["}", ")", "done", "fi", "esac"].map((w) => cmd.lastIndexOf(w)));
      const group = cmd.slice(cmd.startsWith("git status; ") ? "git status; ".length : 0, close);
      expect(out).toContain(group);
    });
  }

  it("still rewrites a sibling command outside the redirected group", () => {
    expect(rewrite("git status; { git diff; cargo test; } > f")).toBe("tkr-exec git status; { git diff; cargo test; } > f");
  });

  it("still rewrites inside compounds whose output is not redirected", () => {
    expect(rewrite("{ git status; git diff; }")).toBe("{ git status; tkr-exec git diff; }");
    expect(rewrite("for f in a b; do git diff $f; git status; done")).toBe("for f in a b; do git diff $f; tkr-exec git status; done");
    expect(rewrite("if true; then git diff; git status; fi")).toBe("if true; then git diff; tkr-exec git status; fi");
    expect(rewrite("while read l; do git diff; git status; done < list")).toBe("while read l; do git diff; tkr-exec git status; done < list");
    expect(rewrite("for f in a; do git diff; done > f; git status")).toBe("for f in a; do git diff; done > f; tkr-exec git status");
  });
});

describe("Claude settings encoding", () => {
  let root: string;
  let config: string;
  let project: string;
  let bin: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tkr-rtk-classes-")));
    const home = join(root, "home");
    config = join(home, ".claude");
    project = join(root, "project");
    bin = join(root, "bin");
    for (const dir of [home, config, project, bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(bin, "pytest"), "#!/bin/sh\necho stub\n");
    chmodSync(join(bin, "pytest"), 0o755);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("CLAUDE_PROJECT_DIR", "");
    vi.stubEnv("TOKMIZER_HOME", join(home, ".tokmizer"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const decide = () => rewriteShellDecision("pytest", {
    host: "claude-code", sessionId: "s", cwd: project, claudeDirs: { configDir: config }, pathEnv: bin, permissionMode: "bypassPermissions"
  }, "tkr-exec", () => {});

  for (const [label, content] of [
    ["empty", ""],
    ["whitespace-only", "  \n"],
    ["BOM-only", "﻿"],
    ["BOM and whitespace", "﻿\n"],
    ["BOM and valid JSON", "﻿" + JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } })]
  ] as const) {
    it(`reads a ${label} settings.json as usable`, () => {
      writeFileSync(join(config, "settings.json"), content);
      expect(decide()?.command).toBe("tkr-exec pytest");
    });
  }

  it("keeps BOM-prefixed deny rules", () => {
    writeFileSync(join(config, "settings.json"), "﻿" + JSON.stringify({ permissions: { deny: ["Bash(pytest:*)"] } }));
    expect(decide()).toBeNull();
  });

  for (const content of ["{ not json", "﻿{ not json", "﻿﻿{}"]) {
    it(`fails closed on invalid JSON ${JSON.stringify(content)}`, () => {
      writeFileSync(join(config, "settings.json"), content);
      expect(decide()).toBeNull();
    });
  }
});

describe("long-running commands behind env prefixes and monorepo runners", () => {
  it("leaves dev servers alone and still shortens builds", async () => {
    const { rewrite } = await import("../hooks-host/pre-tool-rewrite");
    for (const cmd of ["env FOO=1 npm run dev", "FOO=1 pnpm dev", "turbo dev", "turbo run dev --filter web", "nx serve web", "nx run web:serve"]) {
      expect(rewrite(cmd), cmd).toBe(cmd);
    }
    for (const cmd of ["turbo build", "turbo run test", "nx build web", "nx run web:build"]) {
      expect(rewrite(cmd), cmd).not.toBe(cmd);
    }
  });
});
