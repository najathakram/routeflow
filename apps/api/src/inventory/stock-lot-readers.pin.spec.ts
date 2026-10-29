/**
 * SA-975 (row 646, SA-814m P2): the StockLot READER census, count-pinned per file (OP-7: shrink-only, in the style of
 * no-bare-cron.spec.ts).
 *
 * Since #3487 a sale never lowers `StockLot.remainingQty` while a variant/parent transfer still does, so the figure no
 * longer means "left in this lot". No reader computes money or a refusal from it alone today (SA-975 §2: the PO re-apply
 * guard's lot check is redundant behind the ledger check, the bill reversal takes max(lot, ledger), `applyToLots` only
 * re-costs history). This pin makes that true by construction: a NEW lot reader, or one more read in an existing file,
 * fails here, so its author meets the deferred row "lots are receipt history only" before relying on a lot figure.
 *
 * What is counted, per non-spec source file under apps/api/src (the `testing/` fixtures are excluded):
 *   - `stockLot.<read>` delegate reads (findMany / findFirst / findUnique / aggregate / groupBy / count), with any
 *     whitespace or newline tolerated around the dot (`tx.stockLot\n  .findMany(`), PLUS relation reads
 *     (`include: { stockLots: true }`, `stockLots: {` inside an include / select / where), folded into the same count
 *     (first slot below). Re-observed on the current source when the relation shape was added: 0 relation reads exist,
 *     so every pinned figure is unchanged (inventory.service 2, vendor-bills.service 3);
 *   - raw SQL reads `FROM|JOIN "StockLot"`, also schema-qualified (`public."StockLot"`, `"public"."StockLot"`);
 *   - ALIAS reads (fourth slot): the delegate reached without a method call, i.e. handed on as a value
 *     (`const models = [db.stockLot, ...]`, `const { stockLot } = tx`), so a reader through a variable is counted too.
 *     Observed on the current source: exactly one, products/product-delete-classify.ts, which runs
 *     `groupBy({ by: ["productId"] })` on a list of dependent models as an existence check and reads no quantity;
 *   - `remainingQty` references, in files that mention StockLot (the name is also used by unrelated quantities elsewhere,
 *     e.g. credit-note headroom), plus costing.ts, which handles lots handed to it by its callers.
 * Lowering a count is allowed (and required to keep the pin exact); raising one needs a reason on the line below.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

/** [delegate + relation reads, raw reads, remainingQty references, alias reads] */
type Counts = [number, number, number, number];

/** file (relative to apps/api/src) -> its counts */
const PINNED: Record<string, Counts> = {
  "inventory/costing.ts": [0, 0, 2, 0], // planLotConsumption's input type + its draw-down (the transfer's one caller)
  "inventory/inventory.service.ts": [2, 0, 9, 0], // transfer draw-down, PO guard lot check, applyToLots, receipts
  "inventory/po-use-since-receipt.ts": [0, 0, 1, 0], // names the field in its doc (the ledger helper reads no lots)
  "vendor-bills/vendor-bills.service.ts": [3, 0, 10, 0], // bill reversal: max(lotSays, fromLedger) (row 645)
  // NEW kind (alias reads, uncounted before this slot existed): `db.stockLot` is handed into the dependent-models list
  // whose members only get groupBy(productId) for an "is this product referenced" check; no quantity, no cost.
  "products/product-delete-classify.ts": [0, 0, 0, 1],
};

const DELEGATE_READ =
  /stockLot\s*\??\s*\.\s*(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|aggregate|groupBy|count)\b/g;
const RELATION_READ = /\bstockLots\s*:\s*(?:true\b|\{)/g;
const RAW = /(?:FROM|JOIN)\s+(?:"?public"?\s*\.\s*)?"StockLot"/gi;
/** The delegate used as a value (not followed by a call/member access or a key colon), or destructured out of a client. */
const ALIAS =
  /[\w$)\]]\s*\.\s*stockLot\b(?!\s*\??\s*\.)(?!\s*:)|\{[^{}]*\bstockLot\b[^{}]*\}\s*=[^=>]/g;
const REMAINING = /\bremainingQty\b/g;
const MENTIONS_LOT = /stockLot|StockLot/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "testing" || e.name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

function census(): Record<string, Counts> {
  const found: Record<string, Counts> = {};
  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    const lotFile = MENTIONS_LOT.test(text) || rel === "inventory/costing.ts";
    const reads =
      (text.match(DELEGATE_READ) ?? []).length + (text.match(RELATION_READ) ?? []).length;
    const raw = (text.match(RAW) ?? []).length;
    const remaining = lotFile ? (text.match(REMAINING) ?? []).length : 0;
    const alias = (text.match(ALIAS) ?? []).length;
    if (reads || raw || remaining || alias) found[rel] = [reads, raw, remaining, alias];
  }
  return found;
}

describe("SA-975: the StockLot reader census is count-pinned per file", () => {
  const found = census();

  it("every file that reads StockLot or its remainingQty is pinned, with exactly its count", () => {
    expect(found).toEqual(PINNED);
  });

  it("the census is not vacuous: it finds the known readers", () => {
    expect(Object.keys(found)).toEqual(
      expect.arrayContaining([
        "inventory/inventory.service.ts",
        "vendor-bills/vendor-bills.service.ts",
      ]),
    );
    expect(found["inventory/inventory.service.ts"][0]).toBeGreaterThan(0);
  });

  it("the detector matches each shape it claims to and ignores an unrelated remainingQty", () => {
    expect("tx.stockLot.findMany({})".match(DELEGATE_READ)).toHaveLength(1);
    expect("this.prisma.stockLot.aggregate({})".match(DELEGATE_READ)).toHaveLength(1);
    expect("tx.stockLot\n  .findMany({})".match(DELEGATE_READ)).toHaveLength(1); // split across lines
    expect("tx.stockLot  .  count({})".match(DELEGATE_READ)).toHaveLength(1); // stray whitespace
    expect("include: { stockLots: true }".match(RELATION_READ)).toHaveLength(1); // relation include
    expect("select: { stockLots: { where: {} } }".match(RELATION_READ)).toHaveLength(1);
    expect('SELECT 1 FROM "StockLot" l'.match(RAW)).toHaveLength(1);
    expect('SELECT 1 FROM public."StockLot" l'.match(RAW)).toHaveLength(1); // schema-qualified
    expect('SELECT 1 FROM x JOIN public."StockLot" l ON 1=1'.match(RAW)).toHaveLength(1);
    expect('SELECT 1 FROM "public"."StockLot" l'.match(RAW)).toHaveLength(1);
    expect('SELECT 1 FROM public."Product" p'.match(RAW)).toBeNull(); // a different table
    expect('SELECT 1 FROM "StockMovement" m'.match(RAW)).toBeNull();
    expect(
      "const models = [db.orderItem, db.stockLot, db.estimateItem];".match(ALIAS),
    ).toHaveLength(1); // alias handed on as a value
    expect("const { stockLot } = tx;".match(ALIAS)).toHaveLength(1); // destructured
    expect("tx.stockLot.findMany({})".match(ALIAS)).toBeNull(); // a method call is a read/write, not an alias
    expect("tx.stockLot\n  .create({})".match(ALIAS)).toBeNull();
    expect("{ stockLot: { findMany: jest.fn() } }".match(ALIAS)).toBeNull(); // a mock key
    expect("stockLot.create({})".match(DELEGATE_READ)).toBeNull(); // a write is not a read
    expect("tx.stockLot\n  .create({})".match(DELEGATE_READ)).toBeNull();
    expect("stockLots: undefined".match(RELATION_READ)).toBeNull();
    expect(MENTIONS_LOT.test("remainingQty: number // credit-note headroom")).toBe(false);
  });
});
