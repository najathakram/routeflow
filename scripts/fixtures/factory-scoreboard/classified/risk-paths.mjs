// Fixture stand-in for scripts/lib/risk-paths.mjs: only the classifyPath contract matters here.
export function classifyPath(location) {
  return location.includes("billing") ? "money" : "standard";
}
