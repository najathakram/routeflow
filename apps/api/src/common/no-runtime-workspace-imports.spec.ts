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

// Strips `/* ... */` and `// ...` comments before pattern-matching — several of this file's own
// header comments (and trip-grouping.ts's/shipping.ts's) mention `require("@routeflow/types")` or
// `import "@routeflow/types"` in PROSE to explain why the file avoids them; matching raw source
// would flag that documentation as a live offender. Naive by design (no string-literal awareness),
// which only risks a false NEGATIVE if a "//" or "/*" ever appeared inside an actual offending
// import/require's string — not a realistic shape for a package specifier.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Every shape that emits a literal runtime reference to "@routeflow/types" into `dist/` —
// `import type ...` / `export type ...` are erased at compile time and deliberately excluded;
// everything below survives into the compiled output and crashes `node dist/main.js` at boot.
const RUNTIME_TYPES_IMPORT_PATTERNS = [
  // import Foo from "@routeflow/types"; / import { Foo } from "..."; / import * as Foo from "...";
  /(^|\n)\s*import\s+(?!type\b)[^;]*from\s+["']@routeflow\/types["']/,
  // import "@routeflow/types"; — bare side-effect import, no `from` clause.
  /(^|\n)\s*import\s*["']@routeflow\/types["']/,
  // export { Foo } from "..."; / export * from "..."; / export * as ns from "...";
  /(^|\n)\s*export\s+(?!type\b)[^;]*from\s+["']@routeflow\/types["']/,
  // require("@routeflow/types") / require('@routeflow/types')
  /require\s*\(\s*["']@routeflow\/types["']\s*\)/,
  // import("@routeflow/types") / await import('@routeflow/types') — a dynamic import, which the
  // compiled CommonJS output turns into a runtime require() just like the static forms above.
  /\bimport\s*\(\s*["']@routeflow\/types["']\s*\)/,
];

describe("API runtime imports", () => {
  it("never value-imports @routeflow/types from a compiled source file", () => {
    const offenders = collectSourceFiles(SRC_ROOT).filter((file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      return RUNTIME_TYPES_IMPORT_PATTERNS.some((pattern) => pattern.test(source));
    });

    expect(offenders).toEqual([]);
  });
});

describe("RUNTIME_TYPES_IMPORT_PATTERNS — offender-detection coverage", () => {
  const isOffender = (source: string) =>
    RUNTIME_TYPES_IMPORT_PATTERNS.some((pattern) => pattern.test(source));

  it("catches a plain value import", () => {
    expect(isOffender(`import { Foo } from "@routeflow/types";`)).toBe(true);
    expect(isOffender(`import Foo from "@routeflow/types";`)).toBe(true);
    expect(isOffender(`import * as Foo from "@routeflow/types";`)).toBe(true);
  });

  it("catches a bare side-effect import with no `from` clause", () => {
    expect(isOffender(`import "@routeflow/types";`)).toBe(true);
    expect(isOffender(`import '@routeflow/types';`)).toBe(true);
  });

  it("catches a re-export", () => {
    expect(isOffender(`export { Foo } from "@routeflow/types";`)).toBe(true);
    expect(isOffender(`export * from "@routeflow/types";`)).toBe(true);
    expect(isOffender(`export * as types from "@routeflow/types";`)).toBe(true);
  });

  it("catches a require(...) call", () => {
    expect(isOffender(`const { Foo } = require("@routeflow/types");`)).toBe(true);
    expect(isOffender(`const types = require('@routeflow/types');`)).toBe(true);
  });

  it("catches a dynamic import(...) call", () => {
    expect(isOffender(`const types = import("@routeflow/types");`)).toBe(true);
    expect(isOffender(`const types = import('@routeflow/types');`)).toBe(true);
    expect(isOffender(`const types = await import("@routeflow/types");`)).toBe(true);
    expect(isOffender(`const types = await import('@routeflow/types');`)).toBe(true);
  });

  it("never flags a type-only import or re-export (erased at compile time)", () => {
    expect(isOffender(`import type { Foo } from "@routeflow/types";`)).toBe(false);
    expect(isOffender(`export type { Foo } from "@routeflow/types";`)).toBe(false);
    expect(isOffender(`export type * from "@routeflow/types";`)).toBe(false);
  });

  it("never flags an unrelated import", () => {
    expect(isOffender(`import { Foo } from "@routeflow/pricing";`)).toBe(false);
    expect(isOffender(`import "./local-module";`)).toBe(false);
  });

  it("never flags any of the four forms when they only appear in a comment (docs explaining why the file avoids them)", () => {
    const block = stripComments(`/**
 * emits a literal \`require("@routeflow/types")\` at build time, so avoid
 * \`import "@routeflow/types"\`, \`export * from "@routeflow/types"\`, etc.
 */
export const real = 1;`);
    const line = stripComments(
      `// see also: import { Foo } from "@routeflow/types" for the shape\nexport const real = 2;`,
    );
    expect(isOffender(block)).toBe(false);
    expect(isOffender(line)).toBe(false);
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
