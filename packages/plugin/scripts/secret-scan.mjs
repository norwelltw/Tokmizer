import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SECRET_PATTERNS = [
  ["private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Stripe key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["Resend key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["database URL with password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'`/:@]+:[^\s"'`@]+@/]
];

const HOME_PATH = /\/(?:Users|home)\/([a-z][a-z0-9._-]*)\//g;
const GENERIC_HOMES = new Set(["me", "you", "dev", "user", "runner", "linuxbrew", "config", "dana", "sample", "example", "alice", "bob", "test"]);

export function personalHomes(text) {
  const names = new Set();
  for (const m of text.matchAll(HOME_PATH)) {
    if (!GENERIC_HOMES.has(m[1]) && !/^user\d+$/.test(m[1])) names.add(m[1]);
  }
  return [...names];
}

export function privateMarkers(env = process.env) {
  return String(env.TOKMIZER_PRIVATE_MARKERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

export function scanText(text, label, markers = []) {
  const out = [];
  for (const [name, re] of SECRET_PATTERNS) {
    if (re.test(text)) out.push(`${label}: ${name}`);
  }
  if (personalHomes(text).length) out.push(`${label}: home directory path`);
  for (const marker of markers) {
    if (text.includes(marker)) out.push(`${label}: private marker #${markers.indexOf(marker) + 1}`);
  }
  return out;
}

export function walkFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkFiles(p) : [p];
  });
}

export function scanFiles(files, markers = []) {
  const out = [];
  for (const file of files) {
    out.push(...scanText(readFileSync(file).toString("latin1"), file, markers));
  }
  return out;
}

export function selfTest() {
  const samples = [
    ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
    "npm_" + "a".repeat(36),
    "ghp_" + "b".repeat(36),
    ["postgresql://user", "pw@db.example:5432/x"].join(":"),
    ["", "Users", "someone", "project"].join("/")
  ];
  return samples.every((s) => scanText(s, "selftest").length > 0) && scanText("-----BEGIN PUBLIC KEY-----", "selftest").length === 0;
}
