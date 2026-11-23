import * as fs from "fs";
import * as path from "path";

/**
 * Class pin: a source scan that walks ANOTHER workspace must skip generated folders through the ONE shared
 * list (scripts/lib/generated-dirs.cjs). Web jest writes and renames temp files in apps/web/.jest-cache while
 * turbo runs the other workspaces' scans, so a hand-copied skip list without it dies with ENOENT mid-walk
 * and refuses a push. Detection reuses the cross-workspace spec detector, so a new scan joins the pin the day
 * it is written.
 */
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { GENERATED_DIRS } = require("../../../../scripts/lib/generated-dirs.cjs") as {
  GENERATED_DIRS: readonly string[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const detector = require(path.join(REPO_ROOT, "scripts", "lib", "cross-workspace-specs.cjs")) as {
  findCrossWorkspaceSpecs: (root: string) => Record<string, { spec: string }[]>;
};

const DECLARES_OWN_SET = /\bSKIP_DIRS\s*=\s*new Set\b/;
const USES_SHARED = /\.\.\.GENERATED_DIRS\b|\bnew Set\(GENERATED_DIRS\)/;

function crossWorkspaceScanners(): string[] {
  const found = detector.findCrossWorkspaceSpecs(REPO_ROOT);
  return Object.entries(found)
    .flatMap(([ws, list]) => list.map((s) => `${ws}/${s.spec}`))
    .filter((file) => DECLARES_OWN_SET.test(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")))
    .sort();
}

describe("cross-workspace scans skip generated dirs through one shared list", () => {
  it("the shared list names every tool-written folder", () => {
    for (const dir of [
      ".jest-cache",
      ".turbo",
      "coverage",
      ".expo",
      ".next",
      "dist",
      "node_modules",
    ]) {
      expect(GENERATED_DIRS).toContain(dir);
    }
  });

  it("no cross-workspace scan declares its own SKIP_DIRS without GENERATED_DIRS", () => {
    const offenders = crossWorkspaceScanners().filter(
      (file) => !USES_SHARED.test(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("anti-vacuity: the detector still finds the known pricing scan and the matcher tells the shapes apart", () => {
    expect(crossWorkspaceScanners()).toContain("packages/pricing/src/no-mirrors-linepack.spec.ts");
    expect(USES_SHARED.test('const SKIP_DIRS = new Set([...GENERATED_DIRS, "e2e"]);')).toBe(true);
    expect(USES_SHARED.test('const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);')).toBe(
      false,
    );
  });
});
