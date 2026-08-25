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
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || entry.endsWith(".spec.ts")) continue;
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
