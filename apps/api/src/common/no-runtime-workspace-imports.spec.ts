/**
 * Regression guard: the API must never import `@routeflow/types` at RUNTIME.
 *
 * That package's entry point is raw TypeScript (`main: "./index.ts"`, no build
 * step). `nest build` does not bundle workspace deps, so any value import emits
 * a literal `require("@routeflow/types")` into `dist/` and `node dist/main.js`
 * dies at startup parsing the .ts — taking the whole API down, not just the
 * importing module. `tsc --noEmit` and ts-jest both pass, which is why this
 * needs a guard of its own. Shared helpers get mirrored into
 * `apps/api/src/common/` instead (see `trip-grouping.ts`, `shipping.ts`).
 *
 * `import type { … }` is fine — it is erased — as are spec files, which run
 * through ts-jest and never reach `dist/`.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC_ROOT = join(__dirname, "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || entry.endsWith(".d.ts") || /\.spec\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe("API runtime imports", () => {
  it("never value-imports @routeflow/types from a compiled source file", () => {
    const offenders = collectSourceFiles(SRC_ROOT).filter((file) => {
      const source = readFileSync(file, "utf8");
      // `import type ... from "@routeflow/types"` is erased at compile time; a
      // plain `import ... from` (or a `require`) is not.
      return /(^|\n)\s*import\s+(?!type\b)[^;]*from\s+["']@routeflow\/types["']/.test(source);
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * T4/R6 (`@routeflow/pricing`): every `@routeflow/<name>` package the API
 * value-imports from a compiled source file must ship a built (`.js`) `main`
 * — a source-direct workspace package (like `@routeflow/types`, guarded
 * above) crashes `node dist/main.js` at startup. `@routeflow/pricing` is the
 * only workspace package the API is allowed to import at runtime.
 */
function collectRuntimeWorkspacePackages(dir: string): string[] {
  const found = new Set<string>();
  const importRe = /(^|\n)\s*import\s+(?!type\b)[^;]*from\s+["'](@routeflow\/[^"']+)["']/g;

  for (const file of collectSourceFiles(dir)) {
    const source = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    // Reset lastIndex per file — importRe is reused (has the /g flag) across iterations.
    importRe.lastIndex = 0;
    while ((match = importRe.exec(source))) {
      const specifier = match[2];
      // Normalize a subpath import (`@routeflow/x/y`) down to its package (`@routeflow/x`) —
      // this package only ever exposes its "." export, so any subpath would still resolve
      // through the same package.json.
      const pkg = specifier.split("/").slice(0, 2).join("/");
      found.add(pkg);
    }
  }

  return Array.from(found).sort();
}

describe("API runtime imports — @routeflow/pricing (T4/R6)", () => {
  it("value-imports exactly @routeflow/pricing among @routeflow/* packages from compiled source files", () => {
    const imported = collectRuntimeWorkspacePackages(SRC_ROOT);
    expect(imported).toEqual(["@routeflow/pricing"]);
  });

  it("resolves @routeflow/pricing's package.json main to a compiled dist file ending in .js", () => {
    let main: string | undefined;
    try {
      const pkgJsonPath = require.resolve("@routeflow/pricing/package.json");
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      main = typeof pkgJson.main === "string" ? pkgJson.main : undefined;
    } catch {
      main = undefined;
    }

    // Coerce to a string so a missing/unresolvable package fails on the match
    // assertion below, not on an uncaught resolution error.
    expect(main ?? "").toMatch(/\.js$/);
  });

  it("apps/api/package.json jest moduleNameMapper resolves ^@routeflow/pricing$ to packages/pricing/src/index.ts", () => {
    const apiPackageJsonPath = join(SRC_ROOT, "..", "package.json");
    const apiPackageJson = JSON.parse(readFileSync(apiPackageJsonPath, "utf8"));
    const mapped = apiPackageJson.jest?.moduleNameMapper?.["^@routeflow/pricing$"];

    expect(mapped ?? "").toMatch(/packages\/pricing\/src\/index\.ts$/);
  });

  it("apps/mobile/jest.config.js moduleNameMapper resolves ^@routeflow/pricing$ to packages/pricing/src/index.ts", () => {
    const mobileJestConfigPath = join(SRC_ROOT, "..", "..", "mobile", "jest.config.js");
    const mobileJestConfigSource = readFileSync(mobileJestConfigPath, "utf8");
    // Read the mapper by regex, not `require`, so this stays a plain-text
    // check independent of how Jest would transform/execute the mobile config.
    const match = mobileJestConfigSource.match(
      /["']\^@routeflow\/pricing\$["']\s*:\s*["']([^"']+)["']/,
    );

    expect(match?.[1] ?? "").toMatch(/packages\/pricing\/src\/index\.ts$/);
  });
});
