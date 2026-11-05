import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * FG-1 WP2, T4 (R4, SA-1099 section 3): exactly ONE copy of the courtesy rule, and the readers that must not
 * see courtesy do not.
 *
 *   1. The evaluator (`feature-resolver.service.ts`) takes courtesy from `isCourtesyServed` (SA-1100 section
 *      3: one predicate, one home) and never calls `isDarkFlag` / `addonGateState` itself.
 *   2. Outside the old-path files, no source calls `isDarkFlag(` or `addonGateState(`. The list below is
 *      today's OLD PATH (the guards and the oracle that mirrors them); a new call site fails here.
 *   3. The three readers of a resolved key's `.effective` that SA-1099 section 3 found read `.strict`: the
 *      `requires` check, the would-deny log, and the tenant `resolver` field.
 *   4. `.effective` of a resolved key is read only in the files below: they are the places that mean
 *      "what is served".
 */
const SRC = join(__dirname, "..");

function sources(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "generated") continue;
      sources(p, out);
    } else if (/\.ts$/.test(name) && !/\.(spec|db\.spec|test)\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join("/");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (relPath: string) => strip(readFileSync(join(SRC, relPath), "utf8"));
const files = sources().map((p) => ({ path: rel(p), text: strip(readFileSync(p, "utf8")) }));

describe("T4: one courtesy rule, and who may see it", () => {
  it("scans a real tree (guards a vacuous pin)", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("the evaluator takes courtesy from isCourtesyServed, not from its own reading of the registry", () => {
    const text = read("billing/feature-resolver.service.ts");
    expect(text).toMatch(/isCourtesyServed\(/);
    expect(text).not.toMatch(/\bisDarkFlag\(/);
    expect(text).not.toMatch(/\baddonGateState\(/);
  });

  // today's old path: the guards and the code that mirrors what they serve
  const OLD_PATH = new Set([
    "billing/addon-access.ts",
    "billing/addon.guard.ts",
    "billing/entitlement-authority.service.ts",
    "billing/feature-registry.ts",
    "billing/plan-flag-denial.ts",
    "billing/plan-flag-policy.ts",
    "billing/served-answer.ts",
    "products/products.service.ts",
  ]);
  it("no source outside the old path calls isDarkFlag( or addonGateState(", () => {
    const callers = files
      .filter((f) => /\b(isDarkFlag|addonGateState)\(/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !OLD_PATH.has(p));
    expect(callers).toEqual([]);
  });

  it("the old-path list has no stale entry", () => {
    const callers = new Set(
      files.filter((f) => /\b(isDarkFlag|addonGateState)\(/.test(f.text)).map((f) => f.path),
    );
    expect([...OLD_PATH].filter((p) => !callers.has(p))).toEqual([]);
  });

  it("SA-1099 section 3: the requires check reads the strict answer", () => {
    const text = read("billing/entitlement-authority.service.ts");
    const body = text.slice(text.indexOf("async assertFeatureRequiresMet"));
    const until = body.slice(0, body.indexOf("resolveOneFromBatch"));
    expect(until).toMatch(/\.strict\b/);
    expect(until).not.toMatch(/\bv\.effective\b/);
  });

  it("SA-1099 section 3: the would-deny log reads the strict answer", () => {
    const text = read("products/products.service.ts");
    expect(text).toMatch(/byKey\.get\("flag\.forecasting"\)\?\.strict/);
    expect(text).not.toMatch(/byKey\.get\("flag\.forecasting"\)\?\.effective/);
  });

  it("SA-1099 section 3: the tenant `resolver` field is the strict answer", () => {
    const text = read("tenants/tenants.controller.ts");
    expect(text).toMatch(/resolver\[f\.key\] = resolved\.byKey\.get\(f\.key\)\?\.strict/);
    expect(text).not.toMatch(/byKey\.get\(f\.key\)\?\.effective/);
  });

  // files that mean "what is served" when they read a resolved key's `.effective`
  const SERVED_READERS = new Set([
    "billing/entitlement-authority.service.ts",
    "billing/entitlement-sweep.service.ts",
    "billing/feature-preview.service.ts",
    "billing/feature-resolver.service.ts",
    "platform-admin/platform-admin.controller.ts",
  ]);
  it("a resolved key's .effective is read only where 'served' is meant", () => {
    const readers = files
      .filter((f) =>
        /byKey\.get\([^)]*\)\??\.effective\b|\bresolved\.effective\b|\bentry\.effective\b|\bv\.effective\b/.test(
          f.text,
        ),
      )
      .map((f) => f.path)
      .filter((p) => !SERVED_READERS.has(p));
    expect(readers).toEqual([]);
  });
});
