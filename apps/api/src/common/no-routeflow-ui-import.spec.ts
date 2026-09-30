/**
 * #2653 (SA-542a): the API never imports @routeflow/ui. That package holds the web/native UI kit and
 * the shell contract (shell-handoff, shell-bridge), which the API must not take a runtime dependency
 * on: the API's handoff paths are its own constants, and the shared fragment format is a CLIENT
 * contract. This fails if any apps/api source file imports it.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(__dirname, "..", "..");
const SCAN = ["src", "scripts", "prisma"];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

describe("apps/api never imports @routeflow/ui (#2653, SA-542a)", () => {
  it("no import / require / dynamic import of @routeflow/ui anywhere in apps/api", () => {
    const pattern = /(?:from\s+|require\(\s*|import\(\s*)["']@routeflow\/ui(?:\/[^"']*)?["']/;
    const self = relative(ROOT, __filename);
    const offenders = SCAN.flatMap((d) => files(join(ROOT, d)))
      .map((f) => relative(ROOT, f))
      .filter((rel) => rel !== self)
      .filter((rel) => pattern.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });
});
