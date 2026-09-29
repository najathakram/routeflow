import * as fs from "fs";
import * as path from "path";

/**
 * #2728 M1 follow-up (SA-572e/f, item E): a raw-SQL script that writes `Product.barcode`,
 * `Product.unitsPerBox`, or `Product.imageKeys` directly (bypassing `syncProductBarcodesFromLegacy`
 * / `syncProductImagesFromLegacy`) leaves the #2717 M1 mirror rows (`ProductBarcode`/`ProductImage`)
 * stale until the next backfill run re-mirrors that product — a silent drift a report or a reader
 * relying on the rows would never see coming. This tripwire scans EVERY script file under
 * `apps/api/scripts/` and the repo-root `scripts/` (recursively; `.js`/`.mjs`/`.cjs`/`.ts`) for a raw
 * `UPDATE "Product" SET …` statement whose SET clause names one of those three columns, and requires
 * each such file to be BOTH on an explicit allow-list AND to clear the matching mirror table in the
 * same statement/transaction:
 *   - barcode / unitsPerBox  -> must contain `DELETE FROM "ProductBarcode"`
 *   - imageKeys              -> must contain `DELETE FROM "ProductImage"`
 *
 * A new owner-run script that writes one of these columns directly, without clearing the mirror,
 * fails this spec — the fix is either to go through the app's own sync helpers, or to add the
 * DELETE (see propose-pack-sizes.mjs / purge-live-svg-xss.js for the pattern) and add the file to
 * ALLOWED_FILES below.
 *
 * Non-vacuous: this spec is worthless if it silently finds zero matching files, so it also asserts
 * it found (at least) the two scripts it was written to police.
 */

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const SCAN_DIRS = [path.join(REPO_ROOT, "apps", "api", "scripts"), path.join(REPO_ROOT, "scripts")];
const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts"];

const ALLOWED_FILES = new Set([
  path.join(REPO_ROOT, "apps", "api", "scripts", "propose-pack-sizes.mjs"),
  path.join(REPO_ROOT, "apps", "api", "scripts", "purge-live-svg-xss.js"),
]);

function listScriptFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listScriptFiles(full));
    } else if (SCRIPT_EXTENSIONS.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Every `UPDATE "Product" SET <clause>` statement's SET-clause text (up to the next `WHERE`, or
 *  end of the statement/template literal). Dotall so a multi-line template literal is captured. */
function updateProductSetClauses(src: string): string[] {
  const clauses: string[] = [];
  const re = /UPDATE\s+"Product"\s+SET\s+([\s\S]*?)(?:WHERE|`|;|$)/g;
  for (const m of src.matchAll(re)) clauses.push(m[1]);
  return clauses;
}

const WATCHED_COLUMNS: Array<{ name: string; requiredDelete: string }> = [
  { name: "barcode", requiredDelete: 'DELETE FROM "ProductBarcode"' },
  { name: "unitsPerBox", requiredDelete: 'DELETE FROM "ProductBarcode"' },
  { name: "imageKeys", requiredDelete: 'DELETE FROM "ProductImage"' },
];

describe("scripts-product-mirror-tripwire (#2728 M1 follow-up, SA-572e/f item E)", () => {
  it('every raw UPDATE "Product" SET touching barcode/unitsPerBox/imageKeys is allow-listed and clears its mirror table', () => {
    const files = SCAN_DIRS.flatMap(listScriptFiles);
    const flaggedFiles: string[] = [];

    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      const clauses = updateProductSetClauses(src);
      const touchedColumns = new Set<string>();
      for (const clause of clauses) {
        for (const col of WATCHED_COLUMNS) {
          // Match the quoted or bare column name as a SET target (":" for prisma-style templates
          // never appears in raw SQL here, so a simple substring check on the clause is enough).
          if (clause.includes(`"${col.name}"`) || new RegExp(`\\b${col.name}\\b`).test(clause)) {
            touchedColumns.add(col.name);
          }
        }
      }
      if (touchedColumns.size === 0) continue;

      flaggedFiles.push(file);
      expect(ALLOWED_FILES.has(file)).toBe(true);
      for (const col of touchedColumns) {
        const required = WATCHED_COLUMNS.find((c) => c.name === col)!.requiredDelete;
        expect(src).toContain(required);
      }
    }

    // Non-vacuous: this run must have found (at least) the two scripts it exists to police.
    expect(flaggedFiles).toEqual(
      expect.arrayContaining([...ALLOWED_FILES].filter((f) => flaggedFiles.includes(f))),
    );
    expect(flaggedFiles.length).toBeGreaterThanOrEqual(2);
    for (const allowed of ALLOWED_FILES) {
      expect(flaggedFiles).toContain(allowed);
    }
  });
});
