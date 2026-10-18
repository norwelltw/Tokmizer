const MODULES = ["cart", "checkout", "catalog", "billing", "search", "accounts", "orders", "shipping"];
const PARTS = ["api", "model", "store", "view", "util", "hooks"];
const VERBS = ["fix", "feat", "refactor", "test", "chore"];

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick(next, list) {
  return list[Math.floor(next() * list.length)];
}

function hex(next, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += Math.floor(next() * 16).toString(16);
  return out;
}

function path(next, index) {
  return `src/${pick(next, MODULES)}/${pick(next, PARTS)}/${pick(next, PARTS)}-${index % 97}.ts`;
}

function gitLogStat() {
  const next = random(7);
  const lines = [];
  for (let i = 0; i < 400; i++) {
    const day = 1 + (i % 28);
    lines.push(`commit ${hex(next, 40)}`, "Author: Dev Example <dev@example.com>", `Date:   Mon Sep ${day} 10:${String(i % 60).padStart(2, "0")}:00 2026 +0200`, "");
    lines.push(`    ${pick(next, VERBS)}(${pick(next, MODULES)}): change ${i}`, "");
    const files = 1 + Math.floor(next() * 4);
    let added = 0;
    let removed = 0;
    for (let f = 0; f < files; f++) {
      const plus = Math.floor(next() * 20);
      const minus = Math.floor(next() * 10);
      added += plus;
      removed += minus;
      lines.push(` ${path(next, i * 4 + f).padEnd(40)} | ${String(plus + minus).padStart(3)} ${"+".repeat(plus)}${"-".repeat(minus)}`);
    }
    lines.push(` ${files} file${files > 1 ? "s" : ""} changed, ${added} insertions(+), ${removed} deletions(-)`, "");
  }
  return lines.join("\n");
}

function find() {
  const next = random(11);
  const lines = ["."];
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const file = `./${path(next, i)}`;
    const dir = file.slice(0, file.lastIndexOf("/"));
    if (!seen.has(dir)) {
      seen.add(dir);
      lines.push(dir);
    }
    lines.push(file.replace(/\.ts$/, `-${i}.ts`));
  }
  return lines.join("\n") + "\n";
}

function grep() {
  const next = random(13);
  const lines = [];
  for (let i = 0; i < 3000; i++) {
    lines.push(`${path(next, i)}:${1 + Math.floor(next() * 400)}:  // TODO: handle ${pick(next, MODULES)} case ${i % 53}`);
  }
  return lines.join("\n") + "\n";
}

export const GENERATORS = { "git-log-stat": gitLogStat, find, grep };
