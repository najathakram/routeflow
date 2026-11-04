import * as fs from "fs";
import * as path from "path";
import { PACK_INTRO_DECISIONS, packIntroChanges } from "./pack-intro";

/**
 * L-305 inventory pin for SA-946 (W-867). Every numeric (Decimal / Int / Float / BigInt) column of
 * `Product` and `StockLot` has an explicit pack-introduction decision in PACK_INTRO_DECISIONS. A new
 * stock or cost column that lands in the Prisma schema without one goes RED here, so the person adding
 * it has to say whether it is per piece (rescaled when a pack is introduced), a price (never touched,
 * L-332), the pack itself, or unrelated. Stock is kept in pieces (B703) and cost per piece, so a
 * forgotten per-piece column silently keeps its per-box meaning after the pack goes in.
 */
const SCHEMA_DIR = path.resolve(__dirname, "../../prisma/schema");
const MODELS = ["Product", "StockLot"] as const;
const NUMERIC = /^(Decimal|Int|Float|BigInt)\??$/;

const schemaText = () =>
  fs
    .readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".prisma"))
    .map((f) => fs.readFileSync(path.join(SCHEMA_DIR, f), "utf8"))
    .join("\n");

function numericFields(model: string, text = schemaText()): string[] {
  const m = text.match(new RegExp(String.raw`^model ${model} \{([\s\S]*?)^\}`, "m"));
  if (!m) throw new Error(`model ${model} not found in ${SCHEMA_DIR}`);
  const out: string[] = [];
  for (const raw of m[1].split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line || line.startsWith("@@")) continue;
    const [name, type] = line.split(/\s+/);
    if (name && type && NUMERIC.test(type)) out.push(`${model}.${name}`);
  }
  return out;
}

describe("pack-introduction inventory pin (L-305, SA-946)", () => {
  const schemaFields = MODELS.flatMap((m) => numericFields(m)).sort();

  it("the scan found the columns it is meant to guard (not vacuous)", () => {
    expect(schemaFields).toEqual(
      expect.arrayContaining([
        "Product.currentStock",
        "Product.averageCost",
        "Product.unitsPerBox",
        "StockLot.remainingQty",
        "StockLot.unitCost",
      ]),
    );
  });

  it("every numeric Product / StockLot column has a decision, and no decision is stale", () => {
    const decided = Object.keys(PACK_INTRO_DECISIONS).sort();
    expect({
      undecided: schemaFields.filter((f) => !decided.includes(f)),
      stale: decided.filter((f) => !schemaFields.includes(f)),
    }).toEqual({ undecided: [], stale: [] });
  });

  it("goes RED when a new per-piece / cost Decimal or Int lands on Product or StockLot undecided", () => {
    const fake = schemaText().replace(
      /^model StockLot \{/m,
      "model StockLot {\n  pieceCostPerCase Decimal @db.Decimal(10, 4)\n  casesOnHand Int?",
    );
    const decided = Object.keys(PACK_INTRO_DECISIONS);
    expect(numericFields("StockLot", fake).filter((f) => !decided.includes(f))).toEqual([
      "StockLot.pieceCostPerCase",
      "StockLot.casesOnHand",
    ]);
  });

  it("every decision carries a reason", () => {
    for (const [field, d] of Object.entries(PACK_INTRO_DECISIONS)) {
      expect({ field, why: d.why.length > 10 }).toEqual({ field, why: true });
    }
  });

  it("the helper rescales exactly the columns decided scale-up / scale-down, and no other", () => {
    const out = packIntroChanges(
      {
        unitsPerBox: null,
        currentStock: "7.000",
        reorderPoint: 3,
        reorderQty: 5,
        averageCost: "6.0000",
        standardCost: "6.0000",
        stockLots: [{ id: "l", qty: "7.000", remainingQty: "7.000", unitCost: "6.0000" }],
      },
      2,
      "box",
    );
    const touched = [
      ...Object.keys(out?.product ?? {}).map((k) => `Product.${k}`),
      ...Object.keys(out?.lots[0] ?? {})
        .filter((k) => k !== "id")
        .map((k) => `StockLot.${k}`),
    ].sort();
    const decidedScaled = Object.entries(PACK_INTRO_DECISIONS)
      .filter(([, d]) => d.decision === "scale-up" || d.decision === "scale-down")
      .map(([f]) => f)
      .sort();
    expect(touched).toEqual(decidedScaled);
  });
});
