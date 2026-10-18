export type Provider = "anthropic" | "openai" | "google" | "vertex" | "bedrock" | "openrouter";

export const RATES_USD_PER_MTOK: Record<Provider, number> = {
  anthropic: 3,
  openai: 2.5,
  google: 2,
  vertex: 3.3,
  bedrock: 3.5,
  openrouter: 3.5
};

const HOST_PROVIDER: Record<string, Provider> = {
  "claude-code": "anthropic",
  codex: "openai",
  copilot: "openai",
  "gemini-cli": "google",
  cursor: "anthropic",
  windsurf: "anthropic",
  cline: "anthropic",
  aider: "anthropic",
  shell: "anthropic"
};

export function providerForHost(host: string | null | undefined): Provider {
  if (!host) return "anthropic";
  return HOST_PROVIDER[host] ?? "anthropic";
}

export function effectivePricePerMtok(savedByProvider: Partial<Record<Provider, number>>): number {
  let totalSaved = 0;
  let totalUsd = 0;
  for (const key of Object.keys(savedByProvider) as Provider[]) {
    const saved = savedByProvider[key] ?? 0;
    if (saved <= 0) continue;
    totalSaved += saved;
    totalUsd += (saved / 1_000_000) * (RATES_USD_PER_MTOK[key] ?? RATES_USD_PER_MTOK.anthropic);
  }
  if (totalSaved <= 0) return RATES_USD_PER_MTOK.anthropic;
  return totalUsd / (totalSaved / 1_000_000);
}
