/**
 * B524 — static guard for `platform-admin.controller.ts`'s `assertOverrideRequirementsMet`
 * comment: the requires-enforcement for `FeatureOverrideService.create` lives in the
 * CONTROLLER, not inside the service itself, specifically BECAUSE `PlatformAdminController` is
 * the one and only caller of `.create()` anywhere in the codebase — injecting
 * `FeatureResolverService` into `FeatureOverrideService` to do the check inside the service
 * would be circular (`FeatureResolverService` -> `EntitlementsService` ->
 * `FeatureOverrideService` already exists).
 *
 * That equivalence holds only as long as the premise holds. This spec walks every `.ts` source
 * file under `apps/api/src` (excluding `feature-override.service.ts` itself, where `create` is
 * DEFINED, and every `*.spec.ts`/`*.test.ts` fixture) and fails loudly, NAMING the offending
 * file, the moment a second real call site of `featureOverride(s).create(` appears — a script, a
 * seeder, a job, or another service. That is the signal to move (or duplicate) the requires
 * check onto the new call site, not to update this spec's expected count.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SRC_ROOT = path.resolve(__dirname, "..");
const DEFINITION_FILE = path.resolve(__dirname, "feature-override.service.ts");
// `.create(` on a `featureOverride`/`featureOverrides` receiver — covers both the
// constructor-injected property name used throughout this codebase (`featureOverrides`, plural)
// and a hypothetical singular alias, without matching unrelated `.create(` calls (Prisma models,
// other services) that happen to share the method name.
const CALL_PATTERN = /\bfeatureOverrides?\.\s*create\s*\(/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".spec.ts") || entry.name.endsWith(".test.ts")) continue;
    if (full === DEFINITION_FILE) continue;
    out.push(full);
  }
  return out;
}

describe("B524 — FeatureOverrideService.create has exactly one call site", () => {
  const files = collectSourceFiles(SRC_ROOT);

  it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("the pattern actually matches the known, expected call site (a regex matching nothing would report green)", () => {
    const controllerFile = path.resolve(
      __dirname,
      "..",
      "platform-admin",
      "platform-admin.controller.ts",
    );
    const text = fs.readFileSync(controllerFile, "utf8");
    expect(CALL_PATTERN.test(text)).toBe(true);
  });

  it("has exactly one real call site of featureOverride(s).create(, at PlatformAdminController", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const matches = text.match(new RegExp(CALL_PATTERN.source, "g"));
      if (matches) {
        for (let i = 0; i < matches.length; i++) {
          offenders.push(path.relative(SRC_ROOT, file));
        }
      }
    }
    // Exactly one hit, and it must be the known, reviewed controller — a second file (or a
    // second call in the same file) means B524's requires check no longer covers every
    // real write path, and belongs at (or additionally at) the new site.
    expect(offenders).toEqual([path.join("platform-admin", "platform-admin.controller.ts")]);
  });
});
