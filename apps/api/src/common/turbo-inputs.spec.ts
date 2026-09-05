/**
 * T3 (imp-04, wave B′ merge follow-up): turbo cache-safety tripwire for the repo-truth lane.
 *
 * `docs-truth.spec.ts` and `no-dead-deps.spec.ts` (both in this directory) read files OUTSIDE
 * apps/api. apps/api's own `test` task hashes only `$TURBO_DEFAULT$` (its own workspace
 * directory), so without a dedicated turbo task naming those outside paths as `inputs`, an edit
 * to README.md, CLAUDE.md, or apps/web's tree would bust NO hash and `turbo run test` could
 * replay a cached green for a tripwire it never re-ran.
 *
 * A `@routeflow/api#test` workspace-task override was tried for this and reverted:
 * packages/pricing/src/package-shape.spec.ts forbids that exact key. This pins the replacement
 * instead — a GENERIC `test:repo-truth` task (not scoped to any one workspace) carrying the
 * outside paths as explicit inputs. It cannot collide with the forbidden override because it
 * isn't a `<workspace>#<task>` key at all.
 *
 * The outside-apps/api paths below were derived by reading docs-truth.spec.ts (README.md,
 * CLAUDE.md) and no-dead-deps.spec.ts (apps/web/package.json + the app/components/hooks/lib
 * trees it walks, apps/mobile/package.json) — see each spec's own path literals.
 */
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TURBO_JSON_PATH = join(REPO_ROOT, "turbo.json");
const ROOT_PKG_PATH = join(REPO_ROOT, "package.json");
const API_PKG_PATH = join(REPO_ROOT, "apps/api/package.json");

// turbo.json carries `//` line comments (JSONC) — strip them (outside string literals, so
// "https://…" URLs survive) before parsing. Mirrors packages/pricing/src/package-shape.spec.ts.
function readJsonc(filePath: string): Record<string, any> {
  const text = readFileSync(filePath, "utf8");
  let stripped = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (!inString && ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      stripped += "\n";
      continue;
    }
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    stripped += ch;
  }
  return JSON.parse(stripped);
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

// Derived from docs-truth.spec.ts (README.md, CLAUDE.md — both read off REPO_ROOT) and
// no-dead-deps.spec.ts (apps/web/package.json manifest read, plus the four directories its
// `walk()` recurses: apps/web/app, apps/web/components, apps/web/hooks, apps/web/lib; and
// apps/mobile/package.json manifest read).
const OUTSIDE_API_PATHS = [
  "$TURBO_ROOT$/README.md",
  "$TURBO_ROOT$/CLAUDE.md",
  "$TURBO_ROOT$/apps/web/package.json",
  "$TURBO_ROOT$/apps/web/app/**",
  "$TURBO_ROOT$/apps/web/components/**",
  "$TURBO_ROOT$/apps/web/hooks/**",
  "$TURBO_ROOT$/apps/web/lib/**",
  "$TURBO_ROOT$/apps/mobile/package.json",
];

describe("turbo.json test:repo-truth cache-safety", () => {
  const turbo = readJsonc(TURBO_JSON_PATH);

  it("defines a generic test:repo-truth task", () => {
    expect(turbo.tasks).toHaveProperty("test:repo-truth");
  });

  it.each(OUTSIDE_API_PATHS)("hashes %s as an input", (path) => {
    expect(turbo.tasks?.["test:repo-truth"]?.inputs).toContain(path);
  });

  it("never reintroduces the forbidden @routeflow/api#test workspace-task override", () => {
    expect(turbo.tasks).not.toHaveProperty("@routeflow/api#test");
  });
});

describe("verify + package script wiring for test:repo-truth", () => {
  it("root package.json's verify script runs test:repo-truth", () => {
    const rootPkg = readJson(ROOT_PKG_PATH);
    expect(rootPkg.scripts?.verify).toEqual(expect.stringContaining("test:repo-truth"));
  });

  it("apps/api/package.json declares the test:repo-truth script", () => {
    const apiPkg = readJson(API_PKG_PATH);
    expect(apiPkg.scripts?.["test:repo-truth"]).toBe("jest -c jest.repo-truth.config.js");
  });
});

describe("jest config split: main lane ignores the repo-truth specs, repo-truth lane matches only them", () => {
  const apiPkg = readJson(API_PKG_PATH);

  it("the main jest config's testPathIgnorePatterns excludes docs-truth.spec.ts", () => {
    expect(
      (apiPkg.jest?.testPathIgnorePatterns ?? []).some((p: string) =>
        new RegExp(p).test("src/common/docs-truth.spec.ts"),
      ),
    ).toBe(true);
  });

  it("the main jest config's testPathIgnorePatterns excludes no-dead-deps.spec.ts", () => {
    expect(
      (apiPkg.jest?.testPathIgnorePatterns ?? []).some((p: string) =>
        new RegExp(p).test("src/common/no-dead-deps.spec.ts"),
      ),
    ).toBe(true);
  });

  it("jest.repo-truth.config.js's testRegex matches exactly the two repo-truth specs", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const repoTruthConfig = require(join(REPO_ROOT, "apps/api/jest.repo-truth.config.js"));
    const regex = new RegExp(repoTruthConfig.testRegex);
    expect(regex.test("src/common/docs-truth.spec.ts")).toBe(true);
    expect(regex.test("src/common/no-dead-deps.spec.ts")).toBe(true);
    // and nothing else in this same directory
    expect(regex.test("src/common/turbo-inputs.spec.ts")).toBe(false);
    expect(regex.test("src/common/db-locks.spec.ts")).toBe(false);
  });

  it("jest.repo-truth.config.js never inherits the campaign reporter (would clobber .campaign/runs/api.json)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const repoTruthConfig = require(join(REPO_ROOT, "apps/api/jest.repo-truth.config.js"));
    expect(repoTruthConfig.reporters).toEqual(["default"]);
  });
});
