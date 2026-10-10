/**
 * #1315 fold (B686 guard): `tsconfig.spec.json` (the spec-typecheck ratchet's program) extends
 * `tsconfig.json`, but a JSON `exclude` array REPLACES the parent's, it never merges. With
 * `exclude: ["prisma/**", ...]` here, landing this config would silently re-exclude the hand-written
 * `prisma/*.ts` scripts that #1349 (B686) brought into type-checking, so their production-safety
 * guards (`assertSafeTarget()`, `assertTestTenant()`) would again be checked by nothing in this
 * program. Only `prisma/migrations/**` (SQL, irrelevant to tsc) may be excluded.
 *
 * Resolved with the TypeScript compiler API, the same resolution `tsc -p tsconfig.spec.json` uses.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const API_DIR = path.resolve(__dirname, "../..");
const PRISMA_DIR = path.join(API_DIR, "prisma");

function resolvedFileNames(configFileName: string): string[] {
  const configPath = path.join(API_DIR, configFileName);
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
  // TypeScript reports "/"-separated paths on every OS; the expectations use path.join ("\\" on
  // win32), so normalize to the platform form.
  return ts
    .parseJsonConfigFileContent(raw.config, ts.sys, API_DIR)
    .fileNames.map((f) => path.normalize(f));
}

describe("#1315 fold: tsconfig.spec.json keeps the hand-written prisma/*.ts scripts in scope", () => {
  const specFiles = resolvedFileNames("tsconfig.spec.json");

  it("every hand-written prisma/*.ts script is in the tsconfig.spec.json program", () => {
    const handWritten = fs
      .readdirSync(PRISMA_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => path.join(PRISMA_DIR, e.name));
    expect(handWritten.length).toBeGreaterThan(0); // the fixture this test protects must exist
    const missing = handWritten.filter((f) => !specFiles.includes(f));
    expect(missing.map((f) => path.relative(API_DIR, f))).toEqual([]);
  });

  it("prisma/migrations/** (SQL only) stays out of the tsconfig.spec.json program", () => {
    const migrations = path.join(PRISMA_DIR, "migrations") + path.sep;
    expect(specFiles.some((f) => f.startsWith(migrations))).toBe(false);
  });

  it("tsconfig.spec.json never excludes the whole prisma/ folder again", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(API_DIR, "tsconfig.spec.json"), "utf8"));
    const exclude: string[] = cfg.exclude ?? [];
    expect(exclude.filter((e) => /^prisma(\/\*\*)?\/?$/.test(e))).toEqual([]);
  });
});
