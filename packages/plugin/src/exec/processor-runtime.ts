import type { DaemonRuntime } from "../daemon/runtime";

export type ProcessorRuntime = { current: () => DaemonRuntime | null; reload: () => Promise<void> };

export function processorRuntime(
  load: () => Promise<DaemonRuntime | null>,
  builtin: () => DaemonRuntime | null,
  builtinRecheckMs: number
): ProcessorRuntime {
  let runtime: DaemonRuntime | null = null;
  let fromBuiltin = false;
  let reloadedAt = 0;
  let reloading: Promise<void> | null = null;
  const reload = (): Promise<void> => {
    if (reloading) return reloading;
    reloadedAt = Date.now();
    reloading = load()
      .catch(() => null)
      .then((next) => {
        if (next) {
          fromBuiltin = false;
          runtime = next;
          return;
        }
        const fallback = builtin();
        if (!fallback) return;
        const now = Date.now();
        fromBuiltin = true;
        runtime = { ...fallback, signedAt: now, fetchedAt: now };
      })
      .finally(() => {
        reloading = null;
      });
    return reloading;
  };
  return {
    current: () => {
      if (!runtime || (fromBuiltin && Date.now() - reloadedAt > builtinRecheckMs)) void reload();
      return runtime;
    },
    reload
  };
}
