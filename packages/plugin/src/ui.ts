export const M = {
  welcome: "Link your Tokmizer account.",
  needToken: "Tokmizer already works on this device. Linking attaches it to your account.",
  getToken: "Sign in at tokmizer.com, then grab your key from your dashboard.",
  askToken: "Paste your dashboard key, then press Enter:",
  activating: "Linking...",
  activated: (_plan: string) => "Linked.",
  failed: (reason: string) => `Activation failed: ${reason}`,
  suspended: (why: string) => `Your token is suspended. ${why}`,
  revoked: "Your token has been revoked. Contact support at tokmizer.com/contact",
  rotated: "Token rotated. Paste your new token from tokmizer.com/dashboard/token",
  offline: "Network required. Tokmizer needs an internet connection.",
  deviceCap: "Device limit reached. Manage devices at tokmizer.com/dashboard/devices"
};

export function engineNotice(daemonRuleCount: number | null, cachedRuleCount: number | null, builtinRuleCount: number | null = null): string {
  if (daemonRuleCount === null) {
    if (cachedRuleCount !== null) return `  ⚠ engine offline — compression continues on ${cachedRuleCount} cached rules (details: tkr doctor)\n`;
    if (builtinRuleCount !== null && builtinRuleCount > 0) return `  ⚠ engine offline — compression continues on ${builtinRuleCount} built-in rules (details: tkr doctor)\n`;
    return "  ⚠ optimizer engine offline — run: tkr doctor\n";
  }
  if (daemonRuleCount === 0) {
    if (cachedRuleCount !== null && cachedRuleCount > 0) return "";
    if (builtinRuleCount !== null && builtinRuleCount > 0) return "";
    return "  ⚠ optimizer engine reconnecting — savings resume shortly (details: tkr doctor)\n";
  }
  return "";
}
