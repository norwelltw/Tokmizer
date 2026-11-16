import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {processOutput} from "../src/engine/index.js";
import {__resetCache} from "../src/engine/loader.js";
import {stripAnsi} from "../src/engine/transforms/strip-ansi.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtures = join(root, "packages/plugin/src/__tests__/fixtures/video");
const target = join(root, "app/src/content/video/demo.json");
const BEFORE_LINES = 14;
const AFTER_LINES = 22;

const samples = [
  {id: "render", chip: "hyperframes render", cmd: "npx hyperframes render --fps 30 --quality delivery -o renders/demo.mp4", file: "hyperframes-render.txt"},
  {id: "check", chip: "hyperframes check", cmd: "npx hyperframes check", file: "hyperframes-check.txt"},
  {id: "ffmpeg", chip: "ffmpeg", cmd: "ffmpeg -nostdin -y -f lavfi -i testsrc -c:v libx264 clip.mp4", file: "ffmpeg-encode.txt"},
  {id: "ffprobe", chip: "ffprobe", cmd: "ffprobe clip.mp4", file: "ffprobe-default.txt"},
  {id: "blender", chip: "blender", cmd: "blender -b scene.blend -o out/f_ -s 60 -e 61 -a", file: "blender-render.txt"},
  {id: "ytdlp", chip: "yt-dlp", cmd: "yt-dlp -f 299+140 -o clip.mp4 https://www.youtube.com/watch?v=aBcDeFgHiJk", file: "ytdlp-download.txt"}
];

function excerpt(text: string, max: number) {
  const lines = stripAnsi(text).replace(/\r/g, "\n").trimEnd().split("\n").filter(line => line.trim()).map(line => line.length > 160 ? `${line.slice(0, 157)}...` : line);
  return {lines: lines.slice(0, max), omitted: Math.max(0, lines.length - max), total: lines.length};
}

async function main() {
  process.env.TOKMIZER_DEV = "1";
  process.env.TOKMIZER_FILTERS_DIR = join(root, "packages/plugin/filters");
  __resetCache();
  const rows = [];
  for (const sample of samples) {
    const raw = readFileSync(join(fixtures, sample.file), "utf8");
    const result = await processOutput(sample.cmd, raw, null, {exitCode: 0});
    const bytesBefore = Buffer.byteLength(raw, "utf8");
    const bytesAfter = Buffer.byteLength(result.output, "utf8");
    assert.ok(result.filterId, `Unmatched example: ${sample.id}`);
    assert.ok(bytesAfter > 0 && bytesAfter < bytesBefore, `Invalid size: ${sample.id}`);
    rows.push({
      id: sample.id, chip: sample.chip, cmd: sample.cmd, bytesBefore, bytesAfter,
      pct: Math.round((1 - bytesAfter / bytesBefore) * 100),
      before: excerpt(raw, BEFORE_LINES), after: excerpt(result.output, AFTER_LINES)
    });
  }
  const serialized = JSON.stringify(rows, null, 2) + "\n";
  assert.ok(!serialized.includes(homedir()) && !/\/Users\/|\/home\/|HeartbeatRequest|signingSecret|TOKMIZER_/i.test(serialized), "Private data in demo");
  if (process.argv.includes("--check")) {
    assert.equal(readFileSync(target, "utf8"), serialized, "Regenerate video demo outputs");
  } else {
    writeFileSync(target, serialized);
  }
  process.stdout.write(JSON.stringify(rows.map(row => ({command: row.id, before: row.bytesBefore, after: row.bytesAfter, pct: row.pct, linesBefore: row.before.total, linesAfter: row.after.total})), null, 2) + "\n");
}

await main();
