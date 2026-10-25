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
 *   - `stockLot.<read>` delegate reads (findMany / findFirst / findUnique / aggregate / groupBy / count);
 *   - raw SQL reads `FROM|JOIN "StockLot"`;
 *   - `remainingQty` references, in files that mention StockLot (the name is also used by unrelated quantities elsewhere,
 *     e.g. credit-note headroom), plus costing.ts, which handles lots handed to it by its callers.
 * Lowering a count is allowed (and required to keep the pin exact); raising one needs a reason on the line below.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

/** file (relative to apps/api/src) -> [delegate reads, raw reads, remainingQty references] */
const PINNED: Record<string, [number, number, number]> = {
  "inventory/costing.ts": [0, 0, 2], // planLotConsumption's input type + its draw-down (the transfer's one caller)
  "inventory/inventory.service.ts": [2, 0, 9], // transfer draw-down, PO guard lot check, applyToLots, receipts
  "inventory/po-use-since-receipt.ts": [0, 0, 1], // names the field in its doc (the ledger helper reads no lots)
  "vendor-bills/vendor-bills.service.ts": [3, 0, 10], // bill reversal: max(lotSays, fromLedger) (row 645)
};

const READ =
  /stockLot\.(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|aggregate|groupBy|count)\b/g;
const RAW = /(?:FROM|JOIN)\s+"StockLot"/gi;
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

function census(): Record<string, [number, number, number]> {
  const found: Record<string, [number, number, number]> = {};
  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    const lotFile = MENTIONS_LOT.test(text) || rel === "inventory/costing.ts";
    const reads = (text.match(READ) ?? []).length;
    const raw = (text.match(RAW) ?? []).length;
    const remaining = lotFile ? (text.match(REMAINING) ?? []).length : 0;
    if (reads || raw || remaining) found[rel] = [reads, raw, remaining];
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
    expect("tx.stockLot.findMany({})".match(READ)).toHaveLength(1);
    expect("this.prisma.stockLot.aggregate({})".match(READ)).toHaveLength(1);
    expect('SELECT 1 FROM "StockLot" l'.match(RAW)).toHaveLength(1);
    expect("stockLot.create({})".match(READ)).toBeNull(); // a write is not a read
    expect(MENTIONS_LOT.test("remainingQty: number // credit-note headroom")).toBe(false);
  });
});
