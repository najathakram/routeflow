// Repo-truth guard: every Nest module whose controller applies `AddonGuard` must import
// `BillingModule` (the module that provides + exports `AddonService`, the guard's dependency).
//
// Why this exists (2026-09-12, window 16): CrmModule's controller carried per-handler
// `@UseGuards(AddonGuard)` but the module never imported BillingModule. Every unit spec mocked
// at the module boundary, `check-types` cannot see DI scope, and the Docker healthcheck window
// hid the boot crash — the api container threw UnknownDependenciesException at InstanceLoader
// and prod answered 502 until the fix-forward landed. Nest resolves a guard's constructor
// parameters from the scope of the module that registers the controller, so the import is a
// boot-time requirement, not a style choice. This spec reads the source tree and fails the
// build on the shape itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function controllerClassNames(source: string): string[] {
  return [...source.matchAll(/export class (\w+Controller)\b/g)].map((m) => m[1]);
}

describe("AddonGuard consumers import BillingModule", () => {
  const files = walk(SRC);
  const controllers = files.filter(
    (f) =>
      f.endsWith(".controller.ts") &&
      !f.endsWith(".spec.ts") &&
      /\bAddonGuard\b/.test(readFileSync(f, "utf8")),
  );
  const modules = files
    .filter((f) => f.endsWith(".module.ts"))
    .map((f) => ({
      file: f,
      source: readFileSync(f, "utf8"),
    }));

  it("finds at least the known AddonGuard consumers (sanity)", () => {
    expect(controllers.length).toBeGreaterThanOrEqual(3);
  });

  for (const controller of controllers) {
    const rel = relative(SRC, controller).replace(/\\/g, "/");
    it(`${rel}: its registering module imports BillingModule`, () => {
      const names = controllerClassNames(readFileSync(controller, "utf8"));
      expect(names.length).toBeGreaterThan(0);
      const registering = modules.filter((m) =>
        names.some((n) => new RegExp(`controllers:\\s*\\[[^\\]]*\\b${n}\\b`, "s").test(m.source)),
      );
      expect(registering.map((m) => relative(SRC, m.file))).not.toHaveLength(0);
      for (const m of registering) {
        // The billing module itself provides AddonService directly; everything else must
        // import it. `imports: [...]` may span lines, so match across the array body.
        const isBilling = /export class BillingModule\b/.test(m.source);
        const importsBilling = /imports:\s*\[[^\]]*\bBillingModule\b/s.test(m.source);
        expect(isBilling || importsBilling).toBe(true);
      }
    });
  }
});
