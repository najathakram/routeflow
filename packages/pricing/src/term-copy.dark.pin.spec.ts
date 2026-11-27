/**
 * SA-1304 C2 dark pin (pc-sa-3 ruling 7175523856): the yearly words are unreachable until PR-7 and R-1.
 *
 * Two ways to reach `term-copy.ts` once it lives in @routeflow/pricing, and the pin watches both:
 *   1. an index line `export * from "./term-copy"` (the package-name route, which no path grep can see);
 *   2. any non-test file under apps/ or packages/ that names one of the module's exported builders.
 * PR-7 and R-1 add the index export and the importers, and flip ALLOWED_INDEX_EXPORT and ALLOWED_USERS in their own diff.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const MODULE_REL = "packages/pricing/src/term-copy.ts";
const INDEX_REL = "packages/pricing/src/index.ts";

/** PR-7 / R-1 flip this to true when the index exports the module. */
const ALLOWED_INDEX_EXPORT = false;
/** Non-test files allowed to use a builder, repo-relative. PR-7 (labels, emails) and R-1 add rows. */
const ALLOWED_USERS: readonly string[] = [];

/** True when the index source re-exports term-copy (any quote style, with or without `.js`, named or star). */
export function indexExportsTermCopy(indexSrc: string): boolean {
  return /export\s+(\*|\{[^}]*\})(\s+as\s+\w+)?\s+from\s+["']\.\/term-copy(\.js)?["']/.test(
    indexSrc,
  );
}

/** The identifiers the module exports (const, function, type). */
export function exportedNames(moduleSrc: string): string[] {
  const names: string[] = [];
  const re = /^export\s+(?:const|function|type|interface)\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(moduleSrc)) !== null) names.push(m[1]);
  return names;
}

/** The names from `names` that `src` uses as whole words. */
export function usedNames(src: string, names: readonly string[]): string[] {
  return names.filter((n) =>
    new RegExp(`(^|[^\\w$])${n.replace(/\$/g, "\\$")}($|[^\\w$])`).test(src),
  );
}

describe("term-copy dark pin: probes (the detectors go red on a violation)", () => {
  it("sees a star export in the index", () => {
    expect(indexExportsTermCopy('export * from "./term-copy";')).toBe(true);
    expect(indexExportsTermCopy("export * from './term-copy'")).toBe(true);
    expect(indexExportsTermCopy('export { yearPriceLabel } from "./term-copy";')).toBe(true);
    expect(indexExportsTermCopy('export * from "./cents";')).toBe(false);
  });

  it("sees a builder name used outside the module", () => {
    const names = ["yearPriceLabel", "TERM_POLICY"];
    expect(usedNames('import { yearPriceLabel } from "@routeflow/pricing";', names)).toEqual([
      "yearPriceLabel",
    ]);
    expect(usedNames("const x = TERM_POLICY.refundWindow;", names)).toEqual(["TERM_POLICY"]);
    expect(usedNames("const yearPriceLabelX = 1;", names)).toEqual([]);
  });

  it("reads the real exported names", () => {
    const names = exportedNames(fs.readFileSync(path.join(REPO_ROOT, MODULE_REL), "utf8"));
    expect(names).toEqual(
      expect.arrayContaining(["TERM_POLICY", "yearPriceLabel", "refundDoneMessage"]),
    );
    expect(names.length).toBeGreaterThanOrEqual(20);
  });
});

describe("term-copy is dark (pc-sa-3 7175523856)", () => {
  it("the pricing index does not export term-copy", () => {
    const indexSrc = fs.readFileSync(path.join(REPO_ROOT, INDEX_REL), "utf8");
    expect(indexExportsTermCopy(indexSrc)).toBe(ALLOWED_INDEX_EXPORT);
  });

  it("no non-test file outside the module names an exported builder", () => {
    const names = exportedNames(fs.readFileSync(path.join(REPO_ROOT, MODULE_REL), "utf8"));
    const files = execFileSync("git", ["ls-files", "--", "apps", "packages"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
      .filter((f) => !/(\.spec\.|\.test\.|[\\/]__tests__[\\/]|[\\/]e2e[\\/])/.test(f))
      .filter((f) => f !== MODULE_REL);
    expect(files.length).toBeGreaterThan(500);
    const hits = files.filter((f) => {
      const full = path.join(REPO_ROOT, f);
      return fs.existsSync(full) && usedNames(fs.readFileSync(full, "utf8"), names).length > 0;
    });
    expect(hits.sort()).toEqual([...ALLOWED_USERS].sort());
  });
});
