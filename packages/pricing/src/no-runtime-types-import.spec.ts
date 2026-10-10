import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * SA-478a (#2392): packages/pricing's SOURCE may import from @routeflow/types for TYPES only.
 * @routeflow/types has no build step (its entry is raw TypeScript), and the API loads pricing's
 * compiled CJS from `node dist/main.js` — a VALUE import would emit `require("@routeflow/types")`
 * and crash API startup (apps/api/src/common/check-transitions.ts). Specs are exempt: they run
 * under ts-jest, never from dist.
 */
const SRC = __dirname;
const sources = readdirSync(SRC)
  .filter((f) => /\.ts$/.test(f) && !/\.spec\.ts$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(join(SRC, f), "utf8") }));

/** Every `import … from "@routeflow/types"` / `export … from "@routeflow/types"` statement. */
const STATEMENT = /\b(import|export)\s+([^;]*?)\s+from\s+["']@routeflow\/types(?:\/[^"']*)?["']/g;

function valueImporters(): string[] {
  const offenders: string[] = [];
  for (const { file, text } of sources) {
    for (const m of text.matchAll(STATEMENT)) {
      if (!/^type\b/.test(m[2].trim())) offenders.push(`${file}: ${m[0]}`);
    }
  }
  return offenders;
}

describe("packages/pricing imports @routeflow/types for TYPES only (SA-478a)", () => {
  it("no source file value-imports @routeflow/types", () => {
    expect(valueImporters()).toEqual([]);
  });

  it("anti-vacuity: the scan reads pricing's source files and the pattern tells type from value", () => {
    expect(sources.map((s) => s.file)).toContain("nsf-line.ts");
    const probe = (s: string) => [...s.matchAll(STATEMENT)].map((m) => /^type\b/.test(m[2].trim()));
    expect(probe('import type { InvoiceItemSystemKind } from "@routeflow/types";')).toEqual([true]);
    expect(probe('import { INVOICE_ITEM_SYSTEM_KIND_VALUES } from "@routeflow/types";')).toEqual([
      false,
    ]);
    expect(probe('export { X } from "@routeflow/types";')).toEqual([false]);
  });
});
