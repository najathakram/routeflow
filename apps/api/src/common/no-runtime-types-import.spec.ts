/**
 * Static guard: no non-spec file in `apps/api/src` may import a runtime VALUE from `@routeflow/types`.
 *
 * `@routeflow/types` has `main: ./index.ts`, raw TypeScript. The compiled API (`node dist/main.js`, node:24 in the
 * Dockerfile) can `require` it only if nothing is left to load, so every import from it must be `import type` (or
 * `{ type X }`), which the compiler erases. A runtime import dies at boot with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, and
 * neither Jest (ts-jest transpiles it) nor `tsc --noEmit` can see that. Need a shared value in the API? Keep a local
 * const and pin it set-equal to the shared one in a spec (see ready-for-pickup.record.spec.ts).
 *
 * Specs are excluded: they run under ts-jest, which compiles the package.
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

// `import|export [type] <clause> from "@routeflow/types[/sub]"`; `[^;]*?` spans a prettier-wrapped list.
const FROM_TYPES =
  /\b(import|export)\s+(type\s+)?([^;"']*?)\s*from\s*["']@routeflow\/types(?:\/[^"']*)?["']/g;
// `import "@routeflow/types"` (side effect) and `require("@routeflow/types")` always load the module.
const BARE_LOAD = /\bimport\s*["']@routeflow\/types|\brequire\(\s*["']@routeflow\/types/;

/** The offending import/export statements in one file's text (empty when every import is type-only). */
export function runtimeTypesImports(source: string): string[] {
  // Doc comments name the rule ("never import { X } from \"@routeflow/types\""), so only code counts.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/.*$/gm, "$1");
  const bad: string[] = [];
  if (BARE_LOAD.test(text)) bad.push('import "@routeflow/types" / require(...)');
  for (const m of text.matchAll(FROM_TYPES)) {
    if (m[2]) continue; // `import type ...` / `export type ...`: erased
    const clause = m[3].trim();
    const list = clause.match(/\{([^}]*)\}/);
    // `* as ns`, a default import and `export *` all bind the module itself; a brace list is runtime unless every
    // member carries its own `type` keyword.
    const members = list
      ? list[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    if (members && members.every((s) => /^type\s/.test(s))) continue;
    bad.push(m[0].replace(/\s+/g, " "));
  }
  return bad;
}

describe("no runtime import from @routeflow/types in the API (compiled-API boot guard)", () => {
  it("walks real files", () => {
    expect(collectSourceFiles(SRC_ROOT).length).toBeGreaterThan(100);
  });

  it("every import of @routeflow/types in a non-spec file is type-only", () => {
    const offenders: Record<string, string[]> = {};
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const bad = runtimeTypesImports(fs.readFileSync(file, "utf8"));
      if (bad.length) offenders[path.relative(SRC_ROOT, file)] = bad;
    }
    expect(offenders).toEqual({});
  });

  // The matcher itself: the line that shipped broken, and the shapes that must stay legal.
  it.each([
    [
      'import { READY_FOR_PICKUP_NOTICE_VALUES, type ReadyForPickupLast } from "@routeflow/types";',
      true,
    ],
    ['import { A, B } from "@routeflow/types";', true],
    ['import * as T from "@routeflow/types";', true],
    ['import T from "@routeflow/types";', true],
    ['export * from "@routeflow/types";', true],
    ['export { X } from "@routeflow/types";', true],
    ['import { X } from "@routeflow/types/api/enums";', true],
    ['import "@routeflow/types";', true],
    ['const t = require("@routeflow/types");', true],
    ['import {\n  A,\n  type B,\n} from "@routeflow/types";', true],
    ['import type { A, B } from "@routeflow/types";', false],
    ['import { type A, type B } from "@routeflow/types";', false],
    ['import type {\n  A,\n  B,\n} from "@routeflow/types";', false],
    ['export type { A } from "@routeflow/types";', false],
    ['import { Injectable } from "@nestjs/common";', false],
    [
      '/** never import { X } from "@routeflow/types" */\nimport type { X } from "@routeflow/types";',
      false,
    ],
    ['// import { X } from "@routeflow/types";\nconst a = 1;', false],
    ['/**\n * see: import "@routeflow/types"\n */\nimport { X } from "./x";', false],
  ])("matcher: %j is flagged: %s", (text, flagged) => {
    expect(runtimeTypesImports(text).length > 0).toBe(flagged);
  });
});
