import { statCmdLabel } from "./stats";

export type BashRun = { command: string; output: string };

export type ReplayOutcome = {
  command: string;
  rawBytes: number;
  filteredBytes: number;
  filterId: string | null;
};

export type ReplayRow = {
  label: string;
  runs: number;
  routed: number;
  rawTokens: number;
  savedTokens: number;
  lostTokens: number;
};

export type ReplayReport = {
  rows: ReplayRow[];
  totals: { runs: number; routedPct: number; savedTokens: number; lostTokens: number };
};

type UseBlock = { type?: string; id?: string; name?: string; input?: { command?: unknown } };
type ResultBlock = { type?: string; tool_use_id?: string };
type Line = {
  message?: { content?: unknown };
  toolUseResult?: { stdout?: unknown; stderr?: unknown };
};

export function extractBashRuns(jsonlText: string): BashRun[] {
  const parsed: Line[] = [];
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line) as Line);
    } catch {
      continue;
    }
  }
  const commands = new Map<string, string>();
  for (const j of parsed) {
    const content = j.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as UseBlock[]) {
      if (
        b?.type === "tool_use" &&
        b.name === "Bash" &&
        typeof b.id === "string" &&
        typeof b.input?.command === "string"
      ) {
        commands.set(b.id, b.input.command);
      }
    }
  }
  const runs: BashRun[] = [];
  for (const j of parsed) {
    const tur = j.toolUseResult;
    if (!tur || typeof tur.stdout !== "string") continue;
    const content = j.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as ResultBlock[]) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const command = commands.get(b.tool_use_id);
      if (command === undefined) continue;
      const stderr = typeof tur.stderr === "string" ? tur.stderr : "";
      runs.push({ command, output: tur.stdout + stderr });
    }
  }
  return runs;
}

function toTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export function aggregateReplay(outcomes: ReplayOutcome[]): ReplayReport {
  const byLabel = new Map<string, ReplayRow>();
  let routedTotal = 0;
  for (const o of outcomes) {
    const label = statCmdLabel(o.command) || "other";
    const row =
      byLabel.get(label) ?? { label, runs: 0, routed: 0, rawTokens: 0, savedTokens: 0, lostTokens: 0 };
    row.runs += 1;
    row.rawTokens += toTokens(o.rawBytes);
    if (o.filterId) {
      row.routed += 1;
      routedTotal += 1;
      row.savedTokens += Math.max(0, toTokens(o.rawBytes) - toTokens(o.filteredBytes));
    } else {
      row.lostTokens += toTokens(o.rawBytes);
    }
    byLabel.set(label, row);
  }
  const rows = [...byLabel.values()].sort(
    (a, b) => b.lostTokens - a.lostTokens || b.rawTokens - a.rawTokens
  );
  return {
    rows,
    totals: {
      runs: outcomes.length,
      routedPct: outcomes.length ? (routedTotal / outcomes.length) * 100 : 0,
      savedTokens: rows.reduce((s, r) => s + r.savedTokens, 0),
      lostTokens: rows.reduce((s, r) => s + r.lostTokens, 0)
    }
  };
}
