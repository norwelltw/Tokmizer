import { readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { writeTextPreserving, type HookRemoval } from "./hook-config";

export const MANAGED_MARK = "managed-by: tokmizer";

export type ManagedWrite = "added" | "updated" | "present" | "skipped" | "error";

export async function writeManagedFile(file: string, content: string): Promise<ManagedWrite> {
  try {
    if (existsSync(file)) {
      const current = await readFile(file, "utf8");
      if (current === content) return "present";
      if (!current.includes(MANAGED_MARK)) return "skipped";
      return (await writeTextPreserving(file, content)) ? "updated" : "error";
    }
    return (await writeTextPreserving(file, content)) ? "added" : "error";
  } catch {
    return "error";
  }
}

export async function removeManagedFile(file: string, pruneOwnDir = false): Promise<HookRemoval> {
  try {
    if (!existsSync(file)) return "absent";
    if (!(await readFile(file, "utf8")).includes(MANAGED_MARK)) return "absent";
    await unlink(file);
    if (pruneOwnDir) {
      try {
        if ((await readdir(dirname(file))).length === 0) await rmdir(dirname(file));
      } catch {}
    }
    return "removed";
  } catch {
    return "error";
  }
}

export function managedFileInstalled(file: string, read: (f: string) => string): boolean {
  try {
    return read(file).includes(MANAGED_MARK);
  } catch {
    return false;
  }
}

const BLOCK_BEGIN = "<!-- tokmizer:begin managed-by: tokmizer -->";
const BLOCK_END = "<!-- tokmizer:end -->";
const BLOCK_BEGIN_RE = /<!-- tokmizer:begin managed-by: tokmizer(?: agents: ([a-z0-9,-]*))? -->/g;

type Range = { start: number; bodyStart: number; end: number; agents: string[] };

function blockRange(text: string): Range | null {
  const begins = [...text.matchAll(BLOCK_BEGIN_RE)];
  for (let end = text.indexOf(BLOCK_END); end >= 0; end = text.indexOf(BLOCK_END, end + 1)) {
    const begin = begins.filter((m) => m.index! < end).pop();
    if (begin) {
      return {
        start: begin.index!,
        bodyStart: begin.index! + begin[0].length,
        end: end + BLOCK_END.length,
        agents: (begin[1] ?? "").split(",").filter(Boolean)
      };
    }
  }
  return null;
}

function beginMarker(agents: readonly string[]): string {
  const ids = [...new Set(agents)].filter((a) => /^[a-z0-9-]+$/.test(a)).sort();
  return ids.length ? `<!-- tokmizer:begin managed-by: tokmizer agents: ${ids.join(",")} -->` : BLOCK_BEGIN;
}

export function renderBlock(body: string, agents: readonly string[] = []): string {
  const clean = body.replace(BLOCK_BEGIN_RE, "").split(BLOCK_END).join("").trim();
  const begin = beginMarker(agents);
  return clean ? `${begin}\n${clean}\n${BLOCK_END}` : `${begin}\n${BLOCK_END}`;
}

export function upsertBlock(text: string, body: string, agents: readonly string[] = []): string {
  const block = renderBlock(body, agents);
  const range = blockRange(text);
  if (range) return `${text.slice(0, range.start)}${block}${text.slice(range.end)}`;
  const base = text.replace(/\s+$/, "");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export function stripBlock(text: string): string | null {
  const range = blockRange(text);
  if (!range) return null;
  const before = text.slice(0, range.start).replace(/\s+$/, "");
  const after = text.slice(range.end).replace(/^\s+/, "");
  if (!before) return after;
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

export function hasBlock(text: string): boolean {
  return blockRange(text) !== null;
}

export function blockAgents(text: string): string[] {
  return blockRange(text)?.agents ?? [];
}

export function blockBody(text: string): string | null {
  const range = blockRange(text);
  return range ? text.slice(range.bodyStart, range.end - BLOCK_END.length) : null;
}
