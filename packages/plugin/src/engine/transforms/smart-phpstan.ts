import { registerTransform } from "./registry";

type Message = { message?: unknown; line?: unknown; tip?: unknown };
type Report = { totals?: { errors?: unknown; file_errors?: unknown }; files?: Record<string, { messages?: Message[] }>; errors?: unknown[] };

function sharedFolder(paths: string[]): string {
  if (paths.length < 2) return "";
  let prefix = paths[0]!.slice(0, paths[0]!.lastIndexOf("/") + 1);
  for (const p of paths) while (prefix && !p.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1);
  return prefix;
}

export function smartPhpstan(lines: string[]): string[] {
  const text = lines.join("\n").trim();
  if (!text.startsWith("{")) return lines;
  let report: Report;
  try {
    report = JSON.parse(text) as Report;
  } catch {
    return lines;
  }
  if (!report || typeof report !== "object" || !report.files || typeof report.files !== "object") return lines;
  const paths = Object.keys(report.files);
  const folder = sharedFolder(paths);
  const count = paths.reduce((n, p) => n + (report.files![p]!.messages?.length ?? 0), 0);
  const out = [`phpstan: ${count} error${count === 1 ? "" : "s"} in ${paths.length} file${paths.length === 1 ? "" : "s"}${folder ? ` under ${folder}` : ""}`];
  for (const path of paths) {
    const messages = report.files[path]!.messages ?? [];
    out.push(`${path.slice(folder.length)} (${messages.length})`);
    for (const m of messages) {
      const where = typeof m.line === "number" ? `:${m.line}` : ":?";
      const tip = typeof m.tip === "string" && m.tip ? ` — ${m.tip}` : "";
      out.push(`  ${where} ${String(m.message ?? "")}${tip}`);
    }
  }
  for (const e of Array.isArray(report.errors) ? report.errors : []) out.push(`error: ${String(e)}`);
  return out;
}

registerTransform("smart-phpstan", smartPhpstan);
