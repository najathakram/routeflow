/**
 * #2717 pre-M3 — consumer tripwire (seed of the SA-572 I5 guard). The 4-dp component price is a
 * display-only figure ("(included)" sub-lines are never summed, taxed or credited). Until M3 adds
 * its writer and the PDF renderer, NO source file in api / web / mobile may use it.
 * M3 extends ALLOWLIST with those two files, with reasons.
 */
import * as fs from "fs";
import * as path from "path";

// M3 consumers (SA-572 I5: display-only, never summed/taxed/credited). Each is a WRITER of the frozen
// component rows or a spec that pins one; nothing reads the value into a sum.
const ALLOWLIST: string[] = [
  "apps/api/src/orders/line-composition.ts", // order component rows at write time
  "apps/api/src/orders/line-composition.spec.ts", // pins the writer above
  "apps/api/src/invoices/invoice-line-composition.ts", // invoice component rows at bill time
  "apps/api/src/invoices/invoice-composed-edit.ts", // re-stamps the rows on a DRAFT edit
];
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ROOTS = ["apps/api/src", "apps/web", "apps/mobile"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".expo", "coverage", ".turbo"]);
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const NEEDLE = /\b(componentUnitPrice4|displayComponentUnitPrice)\b/;

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (EXT.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

describe("componentUnitPrice4 / displayComponentUnitPrice have no consumer before M3", () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(path.join(REPO_ROOT, r), files);

  it("scans a non-empty file set in every root (L-202: never vacuous)", () => {
    for (const r of ROOTS) {
      const n = files.filter((f) => f.startsWith(path.join(REPO_ROOT, r) + path.sep)).length;
      expect({ root: r, scanned: n > 0 }).toEqual({ root: r, scanned: true });
    }
  });

  it("only allow-listed files reference either helper", () => {
    const offenders = files
      .filter((f) => NEEDLE.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"))
      .filter((f) => !ALLOWLIST.includes(f));
    expect(offenders).toEqual([]);
  });
});
