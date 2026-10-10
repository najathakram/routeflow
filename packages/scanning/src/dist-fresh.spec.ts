import * as fs from "fs";
import * as path from "path";

/**
 * L-176 guard: `@routeflow/scanning` is COMPILED, and apps/web resolves it through
 * `node_modules` -> `main` -> `dist/index.js` (api and mobile alias to src). A worktree whose
 * `dist` is older than `src` silently runs the OLD engine. This fails loudly instead: rebuild
 * with `npm run build -w @routeflow/scanning`. (packages/pricing has no shared dist-freshness
 * helper on master yet — this is the scanning-local equivalent.)
 */
const PKG_ROOT = path.resolve(__dirname, "..");
const SRC = __dirname;
const DIST = path.join(PKG_ROOT, "dist");

const newest = (dir: string, keep: (name: string) => boolean): number =>
  fs
    .readdirSync(dir)
    .filter(keep)
    .reduce((max, name) => Math.max(max, fs.statSync(path.join(dir, name)).mtimeMs), 0);

describe("@routeflow/scanning dist is fresh (L-176)", () => {
  it("dist exists and is not older than src", () => {
    expect(fs.existsSync(path.join(DIST, "index.js"))).toBe(true);
    const srcNewest = newest(SRC, (n) => n.endsWith(".ts") && !n.endsWith(".spec.ts"));
    const distOldest = fs
      .readdirSync(DIST)
      .filter((n) => n.endsWith(".js"))
      .reduce((min, n) => Math.min(min, fs.statSync(path.join(DIST, n)).mtimeMs), Infinity);
    expect(srcNewest).toBeGreaterThan(0);
    expect(distOldest).toBeGreaterThanOrEqual(srcNewest);
  });

  it("every src module has a compiled counterpart", () => {
    const mods = fs
      .readdirSync(SRC)
      .filter((n) => n.endsWith(".ts") && !n.endsWith(".spec.ts"))
      .map((n) => n.replace(/\.ts$/, ".js"));
    for (const m of mods) expect(fs.existsSync(path.join(DIST, m))).toBe(true);
  });
});
