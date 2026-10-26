// Fixture stand-in for scripts/lib/risk-paths.mjs: classifyPath(path) returns { cls }, CLASSES is low to high.
export const CLASSES = ["green", "amber", "red", "black"];
export function classifyPath(p) {
  return { cls: p.includes("billing") ? "red" : p.endsWith(".md") ? "green" : "amber" };
}
