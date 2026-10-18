import { decryptBundle } from "./bundle-crypto";
import { slugKey } from "./contracts";
import { BundlePayload, compileRuntime, type DaemonRuntime } from "./daemon/runtime";

export const DEFAULT_RULES_SECRET = "tokmizer-default-rules-v1";

const SLUG_KEY_RE = /^[0-9a-f]{16}$/;

type Memo = { sealed: string; bundle: BundlePayload | null; runtime?: DaemonRuntime | null; keys?: Set<string> | null };

let memo: Memo | null = null;

function defaultRules(): Memo | null {
  const sealed = process.env.TOKMIZER_DEFAULT_RULES;
  if (!sealed) return null;
  if (memo && memo.sealed === sealed) return memo;
  let bundle: BundlePayload | null = null;
  try {
    bundle = BundlePayload.parse(JSON.parse(decryptBundle(sealed, DEFAULT_RULES_SECRET)));
  } catch {
    bundle = null;
  }
  memo = { sealed, bundle };
  return memo;
}

export function defaultRulesRuntime(): DaemonRuntime | null {
  const rules = defaultRules();
  if (!rules?.bundle) return null;
  if (rules.runtime === undefined) {
    const now = Date.now();
    try {
      rules.runtime = compileRuntime(rules.bundle, { signedAt: now, fetchedAt: now });
    } catch {
      rules.runtime = null;
    }
  }
  return rules.runtime;
}

function defaultRulesKeys(): Set<string> | null {
  const rules = defaultRules();
  if (!rules?.bundle) return null;
  rules.keys ??= new Set(rules.bundle.filters.map((f) => slugKey(f.slug)));
  return rules.keys;
}

export function resolveAllowedFilters(
  allowedFilters: string[] | undefined,
  graceExceeded = false
): Set<string> | null {
  if (graceExceeded || !allowedFilters || allowedFilters.length === 0) {
    const keys = defaultRulesKeys();
    return keys ? new Set(keys) : null;
  }
  return new Set(allowedFilters.map((s) => (SLUG_KEY_RE.test(s) ? s : slugKey(s))));
}
