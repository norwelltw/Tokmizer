import type { LoadedFilter } from "./loader";
import { slugKey } from "../contracts";

let selectionCaches = new WeakMap<object, Map<string, LoadedFilter | null>>();
const SELECT_CACHE_CAP = 256;

export function selectFilter(
  cmd: string,
  filters: Iterable<LoadedFilter>,
  allowedSlugs: Set<string> | null,
  collection: object = filters
): LoadedFilter | null {
  let cache = selectionCaches.get(collection);
  if (!cache) {
    cache = new Map();
    selectionCaches.set(collection, cache);
  }
  const cacheKey = JSON.stringify([cmd, allowedSlugs ? [...allowedSlugs].sort() : null]);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let best: LoadedFilter | null = null;
  for (const f of filters) {
    if (allowedSlugs && !allowedSlugs.has(slugKey(f.slug))) continue;
    if (f.matchRegex.test(cmd)) {
      if (!best || f.priority > best.priority) best = f;
    }
  }

  if (cache.size >= SELECT_CACHE_CAP) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(cacheKey, best);
  return best;
}

export function __resetMatcherCache(): void {
  selectionCaches = new WeakMap();
}
