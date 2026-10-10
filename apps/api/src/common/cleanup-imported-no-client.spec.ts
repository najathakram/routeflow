import * as fs from "fs";
import * as path from "path";

/**
 * #2629 (owner policy 4c, SA-531a): "Cleanup imported customers" is DISABLED until a real import
 * marker exists — the API refuses both entry points (409 CLEANUP_IMPORTED_DISABLED), and no client
 * may name them. This replaces the UI captures: no web or mobile control exists to capture, so the
 * pin is that none can be added without deleting this spec. Runs in the repo-truth lane.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const ROOTS = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/mobile/app",
  "apps/mobile/components",
  "apps/mobile/lib",
];

function sources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(tsx?|jsx?)$/.test(e.name) && !/\.(test|spec)\.(tsx?|jsx?)$/.test(e.name) ? [p] : [];
  });
}

describe("cleanup-imported has no client entry point (#2629)", () => {
  it("no web or mobile source names cleanup-preview / cleanup-imported", () => {
    const offenders = ROOTS.flatMap((r) => sources(path.join(REPO_ROOT, r))).filter((f) =>
      /cleanup-preview|cleanup-imported/.test(fs.readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it("the scan actually reads client sources (never a vacuous pass)", () => {
    expect(ROOTS.flatMap((r) => sources(path.join(REPO_ROOT, r))).length).toBeGreaterThan(100);
  });
});
