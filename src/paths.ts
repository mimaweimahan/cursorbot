import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

export function fromRoot(...parts: string[]): string {
  return path.join(ROOT, ...parts);
}
