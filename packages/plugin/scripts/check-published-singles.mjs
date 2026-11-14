import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function comparePublished(manifest, fetchBinary) {
  const problems = [];
  for (const [key, entry] of Object.entries(manifest)) {
    const bytes = fetchBinary(entry);
    if (!bytes) {
      problems.push(`${key}: ${entry.package}@${entry.version} is not on npm; publish the platform packages first`);
      continue;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== entry.sha256) problems.push(`${key}: the published ${entry.file} has sha256 ${sha256}, dist/native/single.json pins ${entry.sha256}`);
  }
  return problems;
}

function npmFetcher(work) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return (entry) => {
    const folder = join(work, entry.package.replace(/[@/]/g, "_"));
    mkdirSync(folder, { recursive: true });
    let filename;
    try {
      filename = JSON.parse(execFileSync(npm, ["pack", `${entry.package}@${entry.version}`, "--json", "--pack-destination", folder], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].filename;
    } catch {
      return null;
    }
    execFileSync("tar", ["-xzf", join(folder, filename), "-C", folder]);
    return readFileSync(join(folder, "package", entry.file));
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(directory, "dist", "native", "single.json"), "utf8"));
  const work = mkdtempSync(join(tmpdir(), "tkr-published-"));
  let problems;
  try {
    problems = comparePublished(manifest, npmFetcher(work));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (problems.length) {
    console.error(`published single binaries do not match this build:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`published single binaries match: ${Object.keys(manifest).join(", ")}`);
}
