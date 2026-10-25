/**
 * SA-983 section 1 (row 561, risk b): the ProductBarcode WRITER pin, count-pinned (OP-7, shrink-only, in the style of
 * no-bare-cron.spec.ts).
 *
 * `syncProductBarcodesFromLegacy` still FULL-REPLACES a product's barcode rows: it reads every live row, diffs it against
 * `planBarcodeRows`, and deletes whatever the plan does not produce (product-catalog-sync.ts:238-300). That is safe today
 * ONLY because every live row on master is a legacy mirror the sync itself wrote: the sync's `createMany` is the one
 * writer, nothing writes `ProductBarcode.productUnitId`. The day a second writer lands (a level barcode, SA-826 item 9,
 * slices 7 and 9) the replace would delete its rows. This pin turns that latent loss into a red build:
 *
 *   1. `productBarcode.create / createMany / upsert` appear ONLY in product-catalog-sync.ts, once.
 *   2. `INSERT INTO "ProductBarcode"` appears nowhere in apps/api/src or apps/api/scripts.
 *   3. every ProductBarcode DELETE is on the list below (today 4). In the MUST 8 PR (the first level-code writer) each one
 *      either gains `productUnitId: null` or is ruled for levels on its own line; a released LEVEL row is deleted by the
 *      sync's `code: null` delete today, the same class as the live replace.
 *
 * The first level-code writer then fails the build until the narrowing lands with it.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const SCRIPTS_ROOT = path.resolve(__dirname, "..", "..", "scripts");

/** Non-spec source files under `dir` (any .ts / .js / .mjs / .cjs), skipping node_modules and the testing fixtures. */
function files(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "testing") continue;
      files(full, out);
    } else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Code only: whole-line and trailing `//` comments and block comments are dropped before matching. */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, "")))
    .join("\n");
}

const CREATE = /productBarcode\.(?:create|createMany|upsert)\s*\(/g;
const RAW_INSERT = /INSERT\s+INTO\s+"ProductBarcode"/gi;
const DELETE = /productBarcode\.(?:delete|deleteMany)\s*\(|DELETE\s+FROM\s+"ProductBarcode"/gi;

const rel = (f: string) => path.relative(path.resolve(SRC_ROOT, ".."), f).split(path.sep).join("/");
const count = (re: RegExp, text: string) =>
  (text.match(new RegExp(re.source, re.flags.includes("i") ? "gi" : "g")) ?? []).length;

function census(re: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const f of [...files(SRC_ROOT), ...files(SCRIPTS_ROOT)]) {
    const n = count(re, codeOf(fs.readFileSync(f, "utf8")));
    if (n > 0) found[rel(f)] = n;
  }
  return found;
}

/** every ProductBarcode DELETE, per file, with what it removes */
const PINNED_DELETES: Record<string, [number, string]> = {
  "src/products/product-catalog-sync.ts": [
    2,
    "syncProductBarcodesFromLegacy: the live replace (rows the plan does not produce) and the released rows (code: null); both must gain productUnitId: null in the MUST 8 PR",
  ],
  "src/products/product-code-release.ts": [
    1,
    "reactivate: deletes a product's retired rows (retiredCode) before restoring its own code",
  ],
  "scripts/propose-pack-sizes.mjs": [
    1,
    "a one-off repair script's raw DELETE of a product's rows; narrows in the same PR as the sync",
  ],
};

describe("SA-983: the ProductBarcode writers are count-pinned", () => {
  it("create / createMany / upsert exist only in product-catalog-sync.ts, once (the one mirror writer)", () => {
    expect(census(CREATE)).toEqual({ "src/products/product-catalog-sync.ts": 1 });
  });

  it('no raw INSERT INTO "ProductBarcode" exists in apps/api/src or apps/api/scripts', () => {
    expect(census(RAW_INSERT)).toEqual({});
  });

  it("every ProductBarcode delete is on the pinned list, with exactly its count, and each carries a reason", () => {
    expect(census(DELETE)).toEqual(
      Object.fromEntries(Object.entries(PINNED_DELETES).map(([f, [n]]) => [f, n])),
    );
    for (const [, why] of Object.values(PINNED_DELETES)) expect(why.length).toBeGreaterThan(30);
    const total = Object.values(PINNED_DELETES).reduce((a, [n]) => a + n, 0);
    expect(total).toBe(4);
  });

  it("the detectors match the shapes they claim to, and ignore comments", () => {
    for (const code of [
      "await tx.productBarcode.createMany({ data })",
      "await prisma.productBarcode.create({ data })",
      "this.db.productBarcode.upsert({ where })",
    ])
      expect(count(CREATE, codeOf(code))).toBe(1);
    expect(count(RAW_INSERT, codeOf('INSERT INTO "ProductBarcode" (id) VALUES ($1)'))).toBe(1);
    expect(count(DELETE, codeOf("await tx.productBarcode.deleteMany({ where })"))).toBe(1);
    expect(count(DELETE, codeOf('`DELETE FROM "ProductBarcode" WHERE "productId" = $1`'))).toBe(1);
    expect(count(CREATE, codeOf("// tx.productBarcode.createMany({})"))).toBe(0);
    expect(count(CREATE, codeOf("await tx.productBarcode.findMany({})"))).toBe(0);
  });
});
