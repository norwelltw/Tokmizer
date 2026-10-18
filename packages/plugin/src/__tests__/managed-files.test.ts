import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_MARK, hasBlock, removeManagedFile, stripBlock, upsertBlock, writeManagedFile } from "../managed-files";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tok-managed-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("managed files", () => {
  it("adds, keeps, updates and removes only its own file", async () => {
    const file = join(dir, "a", "power.md");
    expect(await writeManagedFile(file, `x\n${MANAGED_MARK}\n`)).toBe("added");
    expect(await writeManagedFile(file, `x\n${MANAGED_MARK}\n`)).toBe("present");
    expect(await writeManagedFile(file, `y\n${MANAGED_MARK}\n`)).toBe("updated");
    expect(await removeManagedFile(file, true)).toBe("removed");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(dir, "a"))).toBe(false);
    expect(await removeManagedFile(file)).toBe("absent");
  });

  it("never overwrites or deletes a file the user wrote", async () => {
    const file = join(dir, "power.md");
    writeFileSync(file, "my own power prompt\n");
    expect(await writeManagedFile(file, `x\n${MANAGED_MARK}\n`)).toBe("skipped");
    expect(readFileSync(file, "utf8")).toBe("my own power prompt\n");
    expect(await removeManagedFile(file)).toBe("absent");
    expect(readFileSync(file, "utf8")).toBe("my own power prompt\n");
  });

  it("keeps a symlinked file a symlink and preserves its mode", async () => {
    const real = join(dir, "real.md");
    writeFileSync(real, `old\n${MANAGED_MARK}\n`);
    chmodSync(real, 0o640);
    const link = join(dir, "link.md");
    symlinkSync(real, link);
    expect(await writeManagedFile(link, `new\n${MANAGED_MARK}\n`)).toBe("updated");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(`new\n${MANAGED_MARK}\n`);
    expect(statSync(real).mode & 0o777).toBe(0o640);
  });

  it("does not remove a non-empty parent directory", async () => {
    mkdirSync(join(dir, "cmds"));
    writeFileSync(join(dir, "cmds", "mine.md"), "keep");
    const file = join(dir, "cmds", "power.md");
    await writeManagedFile(file, MANAGED_MARK);
    expect(await removeManagedFile(file, true)).toBe("removed");
    expect(readFileSync(join(dir, "cmds", "mine.md"), "utf8")).toBe("keep");
  });
});

describe("managed block", () => {
  it("appends, replaces in place and strips without touching user text", () => {
    const user = "# My rules\n\nBe kind.\n";
    const once = upsertBlock(user, "first");
    expect(once.startsWith(user.trimEnd())).toBe(true);
    expect(hasBlock(once)).toBe(true);
    const twice = upsertBlock(once, "second");
    expect(twice).toContain("second");
    expect(twice).not.toContain("first");
    expect(upsertBlock(twice, "second")).toBe(twice);
    expect(stripBlock(twice)).toBe(user);
    expect(stripBlock(user)).toBeNull();
  });

  it("binds the end marker to the nearest begin marker before it", () => {
    const fake = "quote: <!-- tokmizer:begin managed-by: tokmizer --> here\n";
    const text = upsertBlock(fake, "body");
    expect(stripBlock(text)).toBe(fake);
    expect(stripBlock(upsertBlock(text, "other"))).toBe(fake);
  });

  it("keeps user text written after the block", () => {
    const text = `${upsertBlock("top\n", "body")}\nbottom\n`;
    expect(stripBlock(text)).toBe("top\n\nbottom\n");
  });
});
