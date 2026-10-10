import { readFileSync } from "fs";
import { join } from "path";

/**
 * #2671: every Jest config keeps its cache INSIDE its own workspace (`.jest-cache`), never Jest's
 * default shared OS-temp directory (`$TMPDIR/jest_<uid>`). Every verify from a new worktree path
 * re-keyed that shared cache by ~1-2 GB; it reached 8 GB and filled the Mac mini (all Mac lanes
 * stopped, 2026-09-28). A per-workspace cache dies with its worktree, and the janitor sweeps stale
 * entries (step 7). The directory must stay gitignored so it never becomes source or turbo input.
 */
const REPO = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

describe("#2671: Jest caches are per-worktree, never the shared OS-temp cache", () => {
  it("the api base config (inherited by every api lane) points inside apps/api", () => {
    const jest = JSON.parse(read("apps/api/package.json")).jest;
    expect(jest.rootDir).toBe("src");
    expect(jest.cacheDirectory).toBe("<rootDir>/../.jest-cache");
  });

  it.each([
    "apps/api/jest.db.config.js",
    "apps/api/jest.repo-truth.config.js",
    "apps/api/jest.scripts.config.js",
    "apps/api/jest.smtp.config.js",
  ])("%s inherits the base (no cacheDirectory override of its own)", (f) => {
    const src = read(f);
    expect(src).toMatch(/\.\.\.base/);
    expect(src).not.toMatch(/cacheDirectory/);
  });

  it.each([
    "apps/web/jest.config.js",
    "apps/mobile/jest.config.js",
    "packages/pricing/jest.config.js",
    "packages/returns/jest.config.js",
    "packages/scanning/jest.config.js",
  ])("%s sets cacheDirectory to <rootDir>/.jest-cache", (f) => {
    expect(read(f)).toMatch(/cacheDirectory:\s*"<rootDir>\/\.jest-cache"/);
  });

  it(".jest-cache/ is gitignored", () => {
    expect(read(".gitignore")).toMatch(/^\.jest-cache\/$/m);
  });
});
