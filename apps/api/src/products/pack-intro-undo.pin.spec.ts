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

/**
 * SA-1093 G5: the answers are read inside the stock lock. A read before it misses an answer still open and books the old
 * number with no error. Every read has a decision. A new one goes RED, and each decision's lock order is checked here.
 */
const READS_ANSWERS = /\b(boxIntrosOf|inlineRestockFactors)\(/;

const before = (file: string, lock: string, read: string, within: number) => {
  const text = fs.readFileSync(path.join(SRC, file), "utf8");
  const reads = [...text.matchAll(new RegExp(read.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
  expect(reads.length).toBeGreaterThan(0);
  for (const r of reads) {
    expect(text.slice(Math.max(0, r.index - within), r.index)).toContain(lock);
  }
};

const ANSWER_READS: Record<string, () => void> = {
  "returns/returns.service.ts | introsOf.set(productId, await boxIntrosOf(tx, productId));": () =>
    before(
      "returns/returns.service.ts",
      "lockProductsForStock(",
      "boxIntrosOf(tx, productId)",
      300,
    ),
  "returns/inline-returns.service.ts | const factors = await inlineRestockFactors(tx, `RET-${fresh.id.slice(0, 8)}`, restockedIds);":
    () =>
      before(
        "returns/inline-returns.service.ts",
        "lockProductsForStock(",
        "await inlineRestockFactors(",
        200,
      ),
  // Reached only through inlineRestockFactors, whose one caller is the row above.
  "products/pack-intro-undo.ts | const intros = await boxIntrosOf(tx, productId);": () =>
    expect(fs.readFileSync(path.join(SRC, "products/pack-intro-undo.ts"), "utf8")).toContain(
      "export async function inlineRestockFactors",
    ),
  // restockReturnItems locks before it calls a resolver, and the resolver's reads are lazy.
  "returns/returns-restock-pieces.ts | const intros = await boxIntrosOf(tx, item.productId);": () =>
    before("returns/returns-restock.util.ts", "lockProductsForStock(", "resolvePieces(item)", 300),
  // Both callers of appendBillReversals lock the bill's products first.
  "vendor-bills/vendor-bills.service.ts | const intros = await boxIntrosOf(tx, productId);": () =>
    before(
      "vendor-bills/vendor-bills.service.ts",
      "lockProducts(",
      "this.appendBillReversals(",
      400,
    ),
  // The one caller of reversePoReceipts locks the PO's products first.
  "inventory/inventory.service.ts | const intros = await boxIntrosOf(tx, productId);": () =>
    before("inventory/inventory.service.ts", "lockProducts(", "this.reversePoReceipts(", 300),
};

describe("reads of the Boxes answers (SA-1093 G5)", () => {
  const found = sourceFiles(SRC)
    .flatMap((abs) =>
      fs
        .readFileSync(abs, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => READS_ANSWERS.test(l) && !l.startsWith("export async function"))
        .map((l) => `${path.relative(SRC, abs).replace(/\\/g, "/")} | ${l}`),
    )
    .sort();

  it("every read has a decision, and every decision still has its read", () => {
    expect(found).toEqual(Object.keys(ANSWER_READS).sort());
  });

  it.each(Object.keys(ANSWER_READS))("the lock comes first: %s", (key) => {
    ANSWER_READS[key]();
  });

  it("only receive() reads the answers through a resolver", () => {
    const passing = sourceFiles(SRC).filter((abs) =>
      fs.readFileSync(abs, "utf8").includes("inTodaysPieces: true"),
    );
    expect(passing.map((abs) => path.basename(abs))).toEqual(["returns.service.ts"]);
    before("returns/returns.service.ts", "restockReturnItems(", "inTodaysPieces: true", 200);
  });
});

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
