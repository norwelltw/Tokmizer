import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SECRET_PATTERNS = [
  ["private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b|_authToken=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{32,}/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/],
  ["Stripe key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["Resend key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/],
  ["database URL with password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^\s"'`/:@]+:[^\s"'`@]+@/],
  ["server path", /\/srv\/tokmizer\b/]
];

const HOME_PATH = /(?:\/(?:Users|home)\/|\b[A-Za-z]:\\+Users\\+)([A-Za-z][A-Za-z0-9._-]*)(?=[\\/"'`\s]|$)/gm;
const GENERIC_HOMES = new Set(["me", "you", "dev", "user", "runner", "linuxbrew", "config", "dana", "sample", "example", "alice", "bob", "test", "public", "default", "shared", "appdata"]);

export function personalHomes(text) {
  const names = new Set();
  for (const m of text.matchAll(HOME_PATH)) {
    const name = m[1].toLowerCase();
    if (name.length >= 3 && !GENERIC_HOMES.has(name) && !/^user\d+$/.test(name)) names.add(m[1]);
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
    ["", "Users", "someone", "project"].join("/"),
    ["", "Users", "Someone"].join("/"),
    ["C:", "Users", "someone", "x"].join("\\"),
    "sk-ant-" + "c".repeat(40),
    "glpat-" + "d".repeat(20),
    "ghs_" + "e".repeat(40),
    ["-----BEGIN PGP", "PRIVATE KEY BLOCK-----"].join(" "),
    ["rediss://user", "pw@cache.example:6380"].join(":"),
    "/srv/" + "tokmizer/repo"
  ];
  return samples.every((s) => scanText(s, "selftest").length > 0) && scanText("-----BEGIN PUBLIC KEY-----", "selftest").length === 0 && scanText(["C:", "Users", "", "AppData", "Local"].join("\\"), "selftest").length === 0;
}
