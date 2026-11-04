import type { UsageTokens } from "./agent-usage";

type Price = { input: number; output: number; cacheRead: number };

const PRICES: Array<[string, Price]> = [
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-mythos-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-mythos-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-6", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-1", { input: 15, output: 75, cacheRead: 1.5 }],
  ["claude-opus-4", { input: 15, output: 75, cacheRead: 1.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-4-6", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-sonnet-4-5", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1 }],
  ["gpt-6-astra-law", { input: 10, output: 50, cacheRead: 1 }],
  ["gpt-6-astra", { input: 10, output: 50, cacheRead: 1 }],
  ["gpt-6-rosalind", { input: 15, output: 75, cacheRead: 1.5 }],
  ["gpt-6.1-sol", { input: 2, output: 10, cacheRead: 0.1 }],
  ["gpt-6.1-terra", { input: 1, output: 5, cacheRead: 0.05 }],
  ["gpt-6-sol", { input: 2, output: 10, cacheRead: 0.2 }],
  ["gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ["gpt-5.6-sol", { input: 4, output: 20, cacheRead: 0.4 }],
  ["gpt-5.6-terra", { input: 2, output: 12, cacheRead: 0.2 }],
  ["gpt-5.6-luna", { input: 0.2, output: 1.2, cacheRead: 0.02 }],
  ["gpt-5.6-cyber", { input: 12.5, output: 75, cacheRead: 1.25 }],
  ["gpt-5.5-cyber", { input: 12.5, output: 75, cacheRead: 1.25 }],
  ["gpt-5.5", { input: 5, output: 30, cacheRead: 0.5 }],
  ["gpt-5.4-mini", { input: 0.75, output: 4.5, cacheRead: 0.075 }],
  ["gpt-5.4-nano", { input: 0.2, output: 1.25, cacheRead: 0.02 }],
  ["gpt-5.4", { input: 2.5, output: 15, cacheRead: 0.25 }],
  ["gpt-5.3-codex", { input: 1.75, output: 14, cacheRead: 0.175 }],
  ["gpt-5.2", { input: 1.75, output: 14, cacheRead: 0.175 }],
  ["gpt-5.1", { input: 1.25, output: 10, cacheRead: 0.125 }],
  ["gpt-5-mini", { input: 0.25, output: 2, cacheRead: 0.025 }],
  ["gpt-5-nano", { input: 0.05, output: 0.4, cacheRead: 0.005 }],
  ["gpt-5", { input: 1.25, output: 10, cacheRead: 0.125 }]
];

function priceFor(model: string): Price | null {
  const lower = model.toLowerCase();
  const id = lower.slice(Math.max(0, lower.indexOf("claude-"))).replace(/^(?:openai\/)/, "");
  for (const [prefix, price] of PRICES) if (id === prefix || (id.startsWith(prefix) && /^[-@]\d{4}/.test(id.slice(prefix.length)))) return price;
  return null;
}

export function hasModelPrice(model: string): boolean {
  return priceFor(model) !== null;
}

export function estimateCostUsd(model: string, t: UsageTokens): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.input * 1.25 + t.cacheWrite1h * p.input * 2) / 1_000_000;
}
