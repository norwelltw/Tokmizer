#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cliArg = process.argv[2];
const root = cliArg
  ? resolve(process.cwd(), cliArg)
  : resolve(fileURLToPath(import.meta.url), "..", "..", "dist");

if (!existsSync(root)) {
  console.error(`fix-esm-imports: target not found: ${root}`);
  process.exit(1);
}

const importRe = /(from\s+["'])(\.[^"']+?)(["'])/g;
const dynamicImportRe = /(import\s*\(\s*["'])(\.[^"']+?)(["']\s*\))/g;
const sideEffectRe = /(import\s+["'])(\.[^"']+?)(["'])/g;

function rewriteOne(spec, fromDir) {
  if (/\.[a-zA-Z0-9]+$/.test(spec)) return spec;
  if (spec.endsWith("/")) return `${spec}index.js`;
  const abs = resolve(fromDir, spec);
  if (existsSync(abs) && statSync(abs).isDirectory()) return `${spec}/index.js`;
  return `${spec}.js`;
}

function rewriteFile(path) {
  const fromDir = dirname(path);
  const src = readFileSync(path, "utf8");
  const out = src
    .replace(importRe, (_m, p1, p2, p3) => `${p1}${rewriteOne(p2, fromDir)}${p3}`)
    .replace(dynamicImportRe, (_m, p1, p2, p3) => `${p1}${rewriteOne(p2, fromDir)}${p3}`)
    .replace(sideEffectRe, (_m, p1, p2, p3) => `${p1}${rewriteOne(p2, fromDir)}${p3}`);
  if (out !== src) writeFileSync(path, out);
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (entry.endsWith(".js")) rewriteFile(p);
  }
}

walk(root);
console.log(`fix-esm-imports: done (${root})`);
