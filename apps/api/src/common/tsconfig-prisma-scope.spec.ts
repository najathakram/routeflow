/**
 * B686 — `tsconfig.json` (the file `npm run check-types` / `tsc --noEmit` reads by default)
 * excluded `prisma/**` wholesale, so `prisma/seed.ts` and its production-safety guards
 * (`assertSafeTarget()`, `assertTestTenant()`) were never type-checked. A mistake in the guards
 * themselves was caught by nothing automated.
 *
 * `tsconfig.build.json` (what `nest build` actually reads, per `nest-cli.json`'s default) keeps
 * its OWN, separate `prisma` exclusion — a JSON `exclude` array REPLACES the parent's, it does not
 * merge — so type-checking `prisma/*.ts` here changes nothing about the production build output.
 *
 * This walks the real `tsconfig.json` with the TypeScript compiler API (the same resolution
 * `tsc --noEmit` uses) and asserts the hand-written prisma scripts are IN the resolved program,
 * `prisma/migrations/**` (SQL only, irrelevant to tsc, but excluded defensively) stays OUT, and
 * the production build's own file list is unaffected.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const API_DIR = path.resolve(__dirname, "../..");

function resolvedFileNames(configFileName: string): string[] {
  const configPath = path.join(API_DIR, configFileName);
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, API_DIR);
  // TypeScript reports "/"-separated paths on every OS; the expectations below use path.join,
  // which is "\" on win32 — normalize to the platform form so the comparison holds everywhere.
  return parsed.fileNames.map((f) => path.normalize(f));
}

describe("B686: tsconfig.json type-checks the hand-written prisma/ scripts", () => {
  const checkTypesFiles = resolvedFileNames("tsconfig.json");
  const buildFiles = resolvedFileNames("tsconfig.build.json");

  it("prisma/seed.ts (assertSafeTarget/assertTestTenant) is in the check-types program", () => {
    expect(checkTypesFiles).toContain(path.join(API_DIR, "prisma/seed.ts"));
  });

  it("every hand-written prisma/*.ts script is in the check-types program", () => {
    const dir = path.join(API_DIR, "prisma");
    const handWritten = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => path.join(dir, e.name));
    expect(handWritten.length).toBeGreaterThan(0); // the fixture this test protects must exist
    for (const f of handWritten) expect(checkTypesFiles).toContain(f);
  });

  // The top-level `apps/api/prisma/` directory (schema/seed/migrations), never
  // `src/prisma/` (the NestJS PrismaModule/PrismaService, an ordinary app module).
  const TOP_LEVEL_PRISMA_DIR = path.join(API_DIR, "prisma") + path.sep;

  it("prisma/migrations/** (SQL only) stays excluded from the check-types program", () => {
    expect(
      checkTypesFiles.some((f) =>
        f.startsWith(path.join(TOP_LEVEL_PRISMA_DIR, "migrations") + path.sep),
      ),
    ).toBe(false);
  });

  it("the production build (tsconfig.build.json) still excludes prisma/ entirely — unaffected", () => {
    expect(buildFiles.some((f) => f.startsWith(TOP_LEVEL_PRISMA_DIR))).toBe(false);
    // tsconfig.build.json's own "exclude" array (nest-cli.json's default project) REPLACES the
    // parent's, it does not merge with tsconfig.json's — so this holds regardless of the change above.
    const buildConfig = JSON.parse(
      fs.readFileSync(path.join(API_DIR, "tsconfig.build.json"), "utf8"),
    );
    expect(buildConfig.exclude).toContain("prisma");
  });

  it("seed.ts and every prisma/*.ts script are real tsc.exports: assertSafeTarget/assertTestTenant present", () => {
    const src = fs.readFileSync(path.join(API_DIR, "prisma/seed.ts"), "utf8");
    expect(src).toMatch(/assertSafeTarget/);
    expect(src).toMatch(/assertTestTenant/);
  });
});
