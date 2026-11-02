import * as fs from "fs";
import * as path from "path";

/**
 * L-305 inventory pin for SA-1093 (P-1). A ledger row that negates a quantity undoes something, and a quantity read back from a
 * stored row is in the units of its own day. Every such site has a decision here. A new one goes RED, so the person adding it
 * has to say what it does after a Boxes answer.
 */
const SRC = path.resolve(__dirname, "..");

type Decision =
  | "scaled: takes the product of the Boxes answers since the row"
  | "pair: stays at the receipt's quantity, packVoidClosingRows closes the rest"
  | "refused: reversePoReceipts throws RECEIVED_BEFORE_PACK first"
  | "not stored: typed by the caller, in today's pieces"
  | "not stored: worked out from the live line, in today's pieces"
  | "not stored: the remainder, already in today's pieces";

const DECISIONS: Record<string, Decision> = {
  "vendor-bills/vendor-bills.service.ts | quantity: new Prisma.Decimal(original.quantity).negated(),":
    "pair: stays at the receipt's quantity, packVoidClosingRows closes the rest",
  "vendor-bills/vendor-bills.service.ts | quantity: shortfall.mul(shortfallFactor).negated(),":
    "scaled: takes the product of the Boxes answers since the row",
  "inventory/inventory.service.ts | quantity: new Prisma.Decimal(m.quantity).negated(),":
    "refused: reversePoReceipts throws RECEIVED_BEFORE_PACK first",
  "returns/inline-returns.service.ts | quantity: new Prisma.Decimal(item.qty).mul(factors.get(item.productId) ?? 1).neg(),":
    "scaled: takes the product of the Boxes answers since the row",
  "returns/returns.service.ts | quantity: new Prisma.Decimal(undo.get(productId) as number).neg(),":
    "scaled: takes the product of the Boxes answers since the row",
  'inventory/inventory.service.ts | const signed = dto.mode === "ADJUST" && dto.sign === "-" ? pieces.neg() : pieces;':
    "not stored: typed by the caller, in today's pieces",
  "inventory/inventory.service.ts | quantity: totalQtyDecimal.neg(),":
    "not stored: typed by the caller, in today's pieces",
  "inventory/inventory.service.ts | quantity: quantity.neg(),":
    "not stored: typed by the caller, in today's pieces",
  "orders/order-stock.ts | quantity: -qty,":
    "not stored: worked out from the live line, in today's pieces",
  "orders/order-stock.ts | quantity: -delta,":
    "not stored: worked out from the live line, in today's pieces",
  "products/pack-intro-undo.ts | { ...row, type: MovementType.ADJUSTMENT, quantity: remainder.negated() },":
    "not stored: the remainder, already in today's pieces",
};

/** `quantity:` on a row, or the one `signed` a row is built from, with a sign flip in it. */
const NEGATES = /\b(quantity:|const signed\b).*(\.negated?\(\)|\.neg\(\))|\bquantity: *-/;

function negatedRows(relPath: string, text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => NEGATES.test(l))
    .map((l) => `${relPath} | ${l}`);
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory())
      return e.name === "testing" || e.name === "b562-repair" ? [] : sourceFiles(abs);
    return e.name.endsWith(".ts") && !e.name.includes(".spec.") ? [abs] : [];
  });
}

describe("rows that negate a quantity (L-305, SA-1093 P-1)", () => {
  const found = sourceFiles(SRC)
    .flatMap((abs) =>
      negatedRows(path.relative(SRC, abs).replace(/\\/g, "/"), fs.readFileSync(abs, "utf8")),
    )
    .sort();

  it("every one has a decision, and every decision still has its row", () => {
    expect(found).toEqual(Object.keys(DECISIONS).sort());
  });

  it("the scan catches each spelling (not vacuous)", () => {
    for (const line of [
      "quantity: stored.quantity.neg(),",
      "quantity: stored.quantity.negated(),",
      "quantity: -Number(stored.quantity),",
    ]) {
      expect(negatedRows("x.ts", line)).toEqual([`x.ts | ${line}`]);
    }
    expect(negatedRows("x.ts", "quantity: stored.quantity,")).toEqual([]);
  });
});
