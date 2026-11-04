import { totalTokens, type UsageAgent, type UsageRow, type UsageTokens } from "./agent-usage";
import { estimateCostUsd } from "./model-prices";
import { AMBER, RESET, bar, formatCount, formatDollars, formatTokens, header, shortDay } from "./stats";

export const AGENT_LABEL: Record<UsageAgent, string> = { "claude-code": "Claude Code", codex: "Codex" };

type Group = UsageTokens & { key: string; costUsd: number; priced: boolean };

export type UsageSummary = { totals: Group; byAgent: Group[]; byModel: Group[]; byDay: Group[] };

function group(key: string): Group {
  return { key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, requests: 0, costUsd: 0, priced: true };
}

function add(g: Group, r: UsageRow, cost: number | null): void {
  g.input += r.input;
  g.output += r.output;
  g.cacheRead += r.cacheRead;
  g.cacheWrite += r.cacheWrite;
  g.cacheWrite1h += r.cacheWrite1h;
  g.requests += r.requests;
  if (cost === null) g.priced = false;
  else g.costUsd += cost;
}

export function rowCost(r: UsageRow): number | null {
  return estimateCostUsd(r.model, r);
}

export function summarizeUsage(rows: UsageRow[]): UsageSummary {
  const totals = group("total");
  const maps = { agent: new Map<string, Group>(), model: new Map<string, Group>(), day: new Map<string, Group>() };
  const into = (m: Map<string, Group>, key: string): Group => m.get(key) ?? m.set(key, group(key)).get(key)!;
  for (const r of rows) {
    const cost = rowCost(r);
    add(totals, r, cost);
    add(into(maps.agent, r.agent), r, cost);
    add(into(maps.model, r.model), r, cost);
    add(into(maps.day, r.day), r, cost);
  }
  const bySize = (a: Group, b: Group): number => totalTokens(b) - totalTokens(a);
  return {
    totals,
    byAgent: [...maps.agent.values()].sort(bySize),
    byModel: [...maps.model.values()].sort(bySize),
    byDay: [...maps.day.values()].sort((a, b) => a.key.localeCompare(b.key))
  };
}

export function formatBig(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : formatTokens(n);
}

function money(g: Group): string {
  if (g.costUsd === 0 && !g.priced) return "no price";
  const usd = g.costUsd >= 1000 ? `$${g.costUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : formatDollars(g.costUsd);
  return `${usd}${g.priced ? "" : "+"}`;
}

function meter(value: number, top: number, color: boolean, width = 20): string {
  const blocks = top > 0 && value > 0 ? Math.max(1, Math.round((value / top) * width)) : 0;
  return `${bar(blocks, color)}${"░".repeat(width - blocks)}`;
}

const NOTE_SOURCE = "  Read from the Claude Code and Codex logs on this machine.";
const NOTE_PRICE = "  Cost uses public API list prices. A subscription is billed differently.";
const NOTE_PLUS = "  A + means some models have no known price and are left out of the cost.";

export function renderUsage(s: UsageSummary, opts: { color: boolean; subtitle: string; savedTokens?: number | undefined }): string {
  if (s.totals.requests === 0) {
    return "  No agent usage found for this period.\n  tkr usage reads the local logs of Claude Code and Codex.\n";
  }
  const label = (t: string): string => `  ${t.padEnd(15)}`;
  const t = s.totals;
  const lines = header("Agent token usage", opts.subtitle);
  lines.push(
    `${label("Total")}${formatBig(totalTokens(t))} tokens · ${formatCount(t.requests)} requests`,
    `${label("Input")}${formatBig(t.input)}`,
    `${label("Output")}${formatBig(t.output)}`,
    `${label("Cache read")}${formatBig(t.cacheRead)}`,
    `${label("Cache write")}${formatBig(t.cacheWrite + t.cacheWrite1h)}`,
    `${label("API price")}${money(t)} estimated`,
    ""
  );
  const topAgent = Math.max(0, ...s.byAgent.map(totalTokens));
  lines.push("  By agent");
  for (const g of s.byAgent) {
    lines.push(`${label(AGENT_LABEL[g.key as UsageAgent] ?? g.key)}${meter(totalTokens(g), topAgent, opts.color)} ${formatBig(totalTokens(g)).padStart(8)}  ${money(g).padStart(10)}`);
  }
  lines.push("", "  By model");
  const models = s.byModel.slice(0, 8);
  const width = Math.min(28, Math.max(15, ...models.map((g) => g.key.length + 1)));
  const topModel = Math.max(0, ...models.map(totalTokens));
  for (const g of models) {
    const name = g.key.length > width - 1 ? `${g.key.slice(0, width - 2)}…` : g.key;
    lines.push(`  ${name.padEnd(width)}${meter(totalTokens(g), topModel, opts.color, 14)} ${formatBig(totalTokens(g)).padStart(8)}  ${money(g).padStart(10)}`);
  }
  if (s.byModel.length > models.length) lines.push(`  ${`+ ${s.byModel.length - models.length} more`.padEnd(width)}`);
  lines.push("");
  if (opts.savedTokens && opts.savedTokens > 0) {
    const saved = `  Tokmizer kept ${formatTokens(opts.savedTokens)} tokens of tool output out of your context in the same period (tkr gain).`;
    lines.push(opts.color ? `${AMBER}${saved}${RESET}` : saved, "");
  }
  lines.push(NOTE_SOURCE, NOTE_PRICE);
  if (!t.priced) lines.push(NOTE_PLUS);
  lines.push("");
  return lines.join("\n");
}

export function renderUsageDaily(s: UsageSummary, opts: { color: boolean; subtitle: string; days: string[] }): string {
  const byDay = new Map(s.byDay.map((g) => [g.key, g]));
  const width = 30;
  const top = Math.max(0, ...s.byDay.map(totalTokens));
  const rule = "  " + "─".repeat(width + 30);
  const lines = [`  Agent tokens per day · ${opts.subtitle}`, rule];
  for (const day of opts.days) {
    const g = byDay.get(day);
    const value = g ? totalTokens(g) : 0;
    lines.push(`  ${shortDay(day)}  ${meter(value, top, opts.color, width)} ${formatBig(value).padStart(8)}  ${(g ? money(g) : "").padStart(10)}`);
  }
  const total = `  ${"Total".padEnd(5)}  ${"".padEnd(width)} ${formatBig(totalTokens(s.totals)).padStart(8)}  ${money(s.totals).padStart(10)}`;
  lines.push(rule, opts.color ? `${AMBER}${total}${RESET}` : total, "", NOTE_PRICE, "");
  return lines.join("\n");
}

export function usageJson(rows: UsageRow[], s: UsageSummary, since: string | null): string {
  const pick = (g: Group) => ({ input: g.input, output: g.output, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite + g.cacheWrite1h, total: totalTokens(g), requests: g.requests, costUsd: Math.round(g.costUsd * 100) / 100, costComplete: g.priced });
  return JSON.stringify({
    since,
    totals: pick(s.totals),
    byAgent: s.byAgent.map((g) => ({ agent: g.key, ...pick(g) })),
    byModel: s.byModel.map((g) => ({ model: g.key, ...pick(g) })),
    days: rows.map((r) => {
      const cost = rowCost(r);
      return { day: r.day, agent: r.agent, model: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite + r.cacheWrite1h, requests: r.requests, costUsd: cost === null ? null : Math.round(cost * 10000) / 10000 };
    }),
    measurement: { source: "local-agent-logs", tokenCounts: "provider-reported", cost: "api-list-price-estimate" }
  }) + "\n";
}
