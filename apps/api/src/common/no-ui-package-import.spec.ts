/**
 * #2653 / SA-542a — the API never depends on @routeflow/ui, not even for types.
 *
 * The hybrid shell's zod bridge schema lives in @routeflow/ui (web + mobile only) precisely so the
 * API's dependency graph is untouched: @routeflow/ui carries zod and React-facing code, and its
 * entry points are raw TypeScript the compiled API could not load at runtime anyway (the same
 * failure no-runtime-workspace-imports.spec.ts guards for @routeflow/types). Any reference —
 * import, import type, export-from, require, dynamic import — in API source, scripts or specs, or a
 * package.json dependency on it, fails here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const API_ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["src", "scripts", "prisma"].map((d) => join(API_ROOT, d));
const UI_SPECIFIER = /["']@routeflow\/ui(\/[^"']*)?["']/;

function collect(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(c|m)?[jt]sx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// This file names the specifier in its own prose and regex; comments are stripped before matching.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the API never imports @routeflow/ui (#2653)", () => {
  const files = SCAN_DIRS.flatMap((d) => collect(d)).filter((f) => f !== __filename);

  it("scans the API tree (guards a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no API source, script or spec references @routeflow/ui", () => {
    const offenders = files.filter((f) =>
      UI_SPECIFIER.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(offenders).toEqual([]);
  });

  it("apps/api/package.json does not depend on @routeflow/ui", () => {
    const pkg = JSON.parse(readFileSync(join(API_ROOT, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      expect(Object.keys(pkg[field] ?? {})).not.toContain("@routeflow/ui");
    }
  });
});
