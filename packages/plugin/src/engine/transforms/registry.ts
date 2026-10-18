export type LineTransform = (lines: string[]) => string[];

const REGISTRY = new Map<string, LineTransform>();

export function registerTransform(name: string, fn: LineTransform): void {
  REGISTRY.set(name, fn);
}

export function getTransform(name: string): LineTransform | undefined {
  return REGISTRY.get(name);
}
