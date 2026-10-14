import { readFileSync } from "fs";
import { join } from "path";

/**
 * The GET routes Perms PR1 closes to operators, read from the API's own list (`CLOSED_HANDLERS` in
 * apps/api/scripts/lib/operator-account-blast-radius.mjs) so a web test cannot drift from it. Each route becomes
 * a regex (`:param` = one path segment) to match a request URL against.
 */
export function closedOperatorGetRoutes(): { route: string; re: RegExp }[] {
  const src = readFileSync(
    join(__dirname, "..", "..", "api", "scripts", "lib", "operator-account-blast-radius.mjs"),
    "utf8",
  );
  const routes = [...src.matchAll(/h\(\s*"[^"]+",\s*"GET",\s*"([^"]+)"/g)].map((m) => m[1]);
  if (routes.length === 0) throw new Error("no GET routes parsed from CLOSED_HANDLERS");
  return routes.map((route) => ({
    route,
    re: new RegExp(`^${route.replace(/:[^/]+/g, "[^/?]+")}(\\?|$)`),
  }));
}
