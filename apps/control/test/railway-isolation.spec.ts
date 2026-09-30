/**
 * T56 (R27) — the control service deploys in isolation from the rest of the monorepo.
 *
 * Railway only rebuilds it for `apps/control/**` changes, and it depends on no `@routeflow/*`
 * package (and ships no `packages/*` COPY in its Dockerfile).
 */

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CONTROL = path.join(REPO_ROOT, "apps", "control");

function read(file: string): string {
  expect(fs.existsSync(file)).toBe(true);
  return fs.readFileSync(file, "utf8");
}

describe("control railway isolation (T56)", () => {
  it("railway.toml watches only apps/control/**", () => {
    const toml = read(path.join(CONTROL, "railway.toml"));
    const m = toml.match(/watchPatterns\s*=\s*\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const patterns = [...(m as RegExpMatchArray)[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    expect(patterns).toEqual(["apps/control/**"]);
  });

  it("railway.toml health check is the public unauthenticated probe", () => {
    const toml = read(path.join(CONTROL, "railway.toml"));
    expect(toml).toMatch(/healthcheckPath\s*=\s*"\/api\/health\?public=1"/);
  });

  it("package.json has no @routeflow/* dependency of any kind", () => {
    const pkg = JSON.parse(read(path.join(CONTROL, "package.json")));
    const keys = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ];
    expect(keys.filter((k) => k.startsWith("@routeflow/"))).toEqual([]);
  });

  it("Dockerfile copies no packages/* and boots with node dist/main.js", () => {
    const df = read(path.join(CONTROL, "Dockerfile"));
    expect(df).not.toMatch(/COPY[^\n]*packages\//);
    expect(df).toContain('CMD ["node","dist/main.js"]');
    expect(df).toMatch(/apk add --no-cache git openssh-client/);
  });
});
