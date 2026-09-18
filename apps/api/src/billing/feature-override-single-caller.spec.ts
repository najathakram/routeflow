/**
 * B524 — static guard for `platform-admin.controller.ts`'s `createFeatureOverride` comment: the
 * requires-enforcement for `FeatureOverrideService.create` lives in the CONTROLLER, not inside
 * the service itself, specifically BECAUSE `PlatformAdminController` is the one and only caller
 * of `.create()` anywhere in the codebase — injecting `FeatureResolverService` into
 * `FeatureOverrideService` to do the check inside the service would be circular
 * (`FeatureResolverService` -> `EntitlementsService` -> `FeatureOverrideService` already exists).
 *
 * That equivalence holds only as long as the premise holds. This spec fails loudly, NAMING the
 * offending file, the moment a second real call site of `.create()` on a `FeatureOverrideService`
 * instance appears — a script, a seeder, a job, or another service.
 *
 * B524 fix round (Opus review of PR #913, finding F5): the original version matched on a regex
 * over the call-site TEXT (`/\bfeatureOverrides?\.\s*create\s*\(/`), which a case-mismatched
 * property name, a local alias, destructuring, or a dot on its own line could all evade —
 * fragile in exactly the way a "catch every future caller" guard cannot afford to be.
 *
 * This version resolves the actual constructor-injected property NAME bound to the
 * `FeatureOverrideService` type (`private readonly <name>: FeatureOverrideService`) per file,
 * then checks specifically for `<name>.create(` — an early, cruder version that only checked
 * "imports the type AND contains ANY `.create(` call anywhere in the file" produced real false
 * positives on `platform-admin.service.ts` (injects `FeatureOverrideService` as
 * `featureOverrides` for read methods, but its unrelated `tx.tenant.create(`/`tx.user.create(`
 * calls tripped a same-word match) and on files that only MENTION the class name in a comment,
 * never actually importing it. Also widens the scanned root to `apps/api/scripts` and
 * `apps/api/prisma` — the original scan covered only `apps/api/src`, missing exactly the "a
 * script, a seeder, a job" cases the doc comment already claimed to catch.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const API_ROOT = path.resolve(__dirname, "..", "..");
const ROOTS = ["src", "scripts", "prisma"].map((d) => path.join(API_ROOT, d));
const DEFINITION_FILE = path.resolve(__dirname, "feature-override.service.ts");
const CONTROLLER_FILE = path.resolve(
  __dirname,
  "..",
  "platform-admin",
  "platform-admin.controller.ts",
);

// A real ES import naming FeatureOverrideService among its named imports — not a bare
// word-boundary match, so a comment or docstring mentioning the class name doesn't count.
const IMPORT_STATEMENT = /import\s*\{[^}]*\bFeatureOverrideService\b[^}]*\}\s*from/;
// The identifier a constructor binds the injected instance to, e.g.
// `private readonly featureOverrides: FeatureOverrideService,` — captures `featureOverrides`.
// Also matches a plain (non-DI) local/param typing, e.g. `const x: FeatureOverrideService`.
const BOUND_NAME = /\b([A-Za-z_$][\w$]*)\s*:\s*FeatureOverrideService\b/g;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".spec.ts") || entry.name.endsWith(".test.ts")) continue;
    if (full === DEFINITION_FILE || full === CONTROLLER_FILE) continue;
    out.push(full);
  }
  return out;
}

/** Real ES import of the type AND at least one `<boundName>.create(` call on a name that
 *  import actually bound — not just the class name appearing in a comment, and not an
 *  unrelated `.create(` on some other property of the same file. Tolerates whitespace/newlines
 *  around the dot (prettier can wrap `this.featureOverrides\n  .create(`). */
function callsCreateOnAnInjectedInstance(text: string): boolean {
  if (!IMPORT_STATEMENT.test(text)) return false;
  const boundNames = new Set<string>();
  for (const m of text.matchAll(BOUND_NAME)) boundNames.add(m[1]);
  for (const name of boundNames) {
    const callPattern = new RegExp(`\\b${name}\\s*\\.\\s*create\\s*\\(`);
    if (callPattern.test(text)) return true;
  }
  return false;
}

describe("B524 — FeatureOverrideService.create has exactly one call site", () => {
  const files = ROOTS.flatMap((root) => collectSourceFiles(root));

  it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("the known, expected call site actually trips the detector (a check matching nothing would report green)", () => {
    const text = fs.readFileSync(CONTROLLER_FILE, "utf8");
    expect(callsCreateOnAnInjectedInstance(text)).toBe(true);
  });

  it("a file that only mentions the class name in a comment/docstring is NOT a false positive", () => {
    const fixture = `
      /** See FeatureOverrideService.create() for the auto-close behavior. */
      export class Unrelated {
        async run() { await this.somethingElse.create({}); }
      }
    `;
    expect(callsCreateOnAnInjectedInstance(fixture)).toBe(false);
  });

  it("a file that injects FeatureOverrideService but calls .create( on a DIFFERENT property is NOT a false positive", () => {
    const fixture = `
      import { FeatureOverrideService } from "./feature-override.service";
      class Svc {
        constructor(private readonly featureOverrides: FeatureOverrideService, private readonly prisma: Prisma) {}
        async run() { await this.prisma.user.create({}); }
      }
    `;
    expect(callsCreateOnAnInjectedInstance(fixture)).toBe(false);
  });

  it("has zero OTHER files that both import FeatureOverrideService AND call .create( on the bound instance", () => {
    const offenders = files
      .filter((f) => callsCreateOnAnInjectedInstance(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(API_ROOT, f));
    // Any hit here means a file OTHER than the one reviewed, DI-aware controller both holds a
    // FeatureOverrideService and calls .create() on it — B524's requires check no longer covers
    // every real write path, and belongs at (or additionally at) the new site.
    expect(offenders).toEqual([]);
  });
});
