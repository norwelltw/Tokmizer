import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFilters, __resetCache } from "../engine/loader";
import { selectFilter, __resetMatcherCache } from "../engine/matcher";
import { applyFilter } from "../engine/pipeline";
import "../engine/transforms/squeeze-output";

let origDev: string | undefined;

beforeEach(() => {
  origDev = process.env.TOKMIZER_DEV;
  process.env.TOKMIZER_DEV = "1";
  __resetCache();
  __resetMatcherCache();
});

afterEach(() => {
  if (origDev === undefined) delete process.env.TOKMIZER_DEV;
  else process.env.TOKMIZER_DEV = origDev;
  __resetCache();
  __resetMatcherCache();
});

const pick = async (cmd: string) => {
  const filters = await loadFilters();
  return selectFilter(cmd, filters.values(), null);
};

describe("catalog gaps: build tools", () => {
  it("routes go build and strips module download noise", async () => {
    const f = await pick("go build ./...");
    expect(f?.slug).toBe("go-build");
    const out = applyFilter(
      ["go: downloading golang.org/x/sys v0.30.0", "go: downloading golang.org/x/term v0.28.0", "ok done"].join("\n"),
      f!
    );
    expect(out).not.toContain("downloading");
    expect(out).toContain("ok done");
  });

  it("does not shadow go test (dedicated filter stays)", async () => {
    const f = await pick("go test ./...");
    expect(f?.slug).toBe("go-test");
  });

  it("routes vite, webpack and esbuild", async () => {
    expect((await pick("vite build"))?.slug).toBe("vite");
    expect((await pick("npx vite build"))?.slug).toBe("vite");
    expect((await pick("webpack --mode production"))?.slug).toBe("webpack");
    expect((await pick("esbuild src/index.ts --bundle"))?.slug).toBe("esbuild");
  });

  it("routes bun and deno", async () => {
    expect((await pick("bun install"))?.slug).toBe("bun");
    expect((await pick("deno task check"))?.slug).toBe("deno");
  });
});

describe("catalog gaps: runners and frameworks", () => {
  it("routes playwright with failures kept", async () => {
    const f = await pick("npx playwright test");
    expect(f?.slug).toBe("playwright");
    expect(f?.keep_failures).toBe(true);
  });

  it("npx generic catches unknown tools but loses to specific npx filters", async () => {
    expect((await pick("npx some-random-tool --flag"))?.slug).toBe("npx");
    expect((await pick("npx vitest run"))?.slug).toBe("vitest");
    expect((await pick("npx nx build"))?.slug).toBe("nx");
  });

  it("routes rails and rake", async () => {
    expect((await pick("rails routes"))?.slug).toBe("rails");
    expect((await pick("bundle exec rails db:migrate"))?.slug).toBe("rails");
    expect((await pick("rake -T"))?.slug).toBe("rake");
  });
});

describe("catalog gaps: databases (data outputs, high cap only)", () => {
  it("routes psql, mysql, sqlite3 with a high line cap and no aggressive stripping", async () => {
    for (const [cmd, slug] of [["psql -c 'select 1'", "psql"], ["mysql -e 'show tables'", "mysql"], ["sqlite3 db.sqlite '.tables'", "sqlite3"]] as const) {
      const f = await pick(cmd);
      expect(f?.slug).toBe(slug);
      expect(f?.max_lines).toBeGreaterThanOrEqual(400);
      expect(f?.transform).toBeUndefined();
    }
  });
});

describe("catalog gaps: deploy and SaaS CLIs", () => {
  it("routes vercel, wrangler, netlify, firebase", async () => {
    expect((await pick("vercel deploy --prod"))?.slug).toBe("vercel");
    expect((await pick("npx wrangler deploy"))?.slug).toBe("wrangler");
    expect((await pick("netlify deploy"))?.slug).toBe("netlify");
    expect((await pick("firebase deploy"))?.slug).toBe("firebase");
  });

  it("stripe stays JSON-safe (no line caps at all)", async () => {
    const f = await pick("stripe customers list");
    expect(f?.slug).toBe("stripe");
    expect(f?.max_lines).toBeUndefined();
    expect(f?.truncate_lines_at).toBeUndefined();
  });

  it("routes supabase", async () => {
    expect((await pick("supabase status"))?.slug).toBe("supabase");
  });
});

describe("ls -l routes to the column-dropping transform", () => {
  it("routes ls -la to the long-format filter with the compact transform", async () => {
    const f = await pick("ls -la /tmp");
    expect(f?.slug).toBe("ls-long");
    expect(f?.transform).toBe("smart-ls");
  });

  it("plain ls keeps the compact transform", async () => {
    const f = await pick("ls src/");
    expect(f?.slug).toBe("ls");
    expect(f?.transform).toBe("smart-ls");
  });
});
