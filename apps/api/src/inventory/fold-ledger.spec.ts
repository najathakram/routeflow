import { CostingMethod, MovementType, Prisma } from "@prisma/client";
import { foldLedger, isReplayCorrection } from "./fold-ledger";
import { InventoryService } from "./inventory.service";

/**
 * Row 635 / SA-902 MUST 3: ONE fold. `foldLedger` is the loop `replayProduct` runs, extracted so the B562 D2 average
 * repair reconstructs with the same code (a JS copy is a FAIL). Parity: over the same rows, `foldLedger`'s average equals
 * the live replay's `newAvgCost`.
 */
const D = (v: number | string) => new Prisma.Decimal(v);
type Row = {
  type: MovementType;
  quantity: number;
  unitCost?: number | null;
  reference?: string | null;
};
const rows = (...r: Row[]) =>
  r.map((x, i) => ({
    id: `m${i}`,
    type: x.type,
    quantity: D(x.quantity),
    unitCost: x.unitCost == null ? null : D(x.unitCost),
    reference: x.reference ?? null,
    avgCostAfter: null,
  }));

/** The live replay over `movements`, through the public in-tx entry, writing nothing (no drift → no correction read). */
async function liveReplay(
  movements: ReturnType<typeof rows>,
  opts: { costingMethod?: CostingMethod; averageCost?: number | null } = {},
) {
  const stock = movements.reduce((s, m) => s.add(m.quantity), D(0));
  const tx = {
    product: {
      findFirst: jest.fn().mockResolvedValue({
        id: "p1",
        name: "P",
        currentStock: stock,
        averageCost: opts.averageCost == null ? null : D(opts.averageCost),
        costingMethod: opts.costingMethod ?? CostingMethod.AVCO,
      }),
      update: jest.fn().mockResolvedValue({ currentStock: stock }),
    },
    stockMovement: {
      findMany: jest.fn().mockResolvedValue(movements),
      create: jest.fn().mockResolvedValue({ id: "corr" }),
    },
  };
  const svc = new InventoryService({} as any, {} as any);
  return svc.recomputeProductInTx(tx as any, "p1", { throwOnGap: false });
}

// Every row has its third element: `it.each` passes `done` to a test fn that takes more params than the row has.
const CASES: Array<[string, Row[], { costingMethod?: CostingMethod; averageCost?: number }]> = [
  [
    "§0 pair with the sale on the ledger: 10@1, sell 8, 10@3 → 2.6667",
    [
      { type: MovementType.PURCHASE, quantity: 10, unitCost: 1 },
      { type: MovementType.SALE, quantity: -8 },
      { type: MovementType.PURCHASE, quantity: 10, unitCost: 3 },
    ],
    {},
  ],
  [
    "sales-blind: 10@1, 10@3, then the backfill −8 → 2.0",
    [
      { type: MovementType.PURCHASE, quantity: 10, unitCost: 1 },
      { type: MovementType.PURCHASE, quantity: 10, unitCost: 3 },
      { type: MovementType.SALE, quantity: -8, reference: "B562:BACKFILL:h" },
    ],
    {},
  ],
  [
    "a bill revert reverses the average (negative PURCHASE)",
    [
      { type: MovementType.PURCHASE, quantity: 10, unitCost: 2 },
      { type: MovementType.PURCHASE, quantity: 5, unitCost: 5 },
      { type: MovementType.PURCHASE, quantity: -5, unitCost: 5 },
    ],
    {},
  ],
  [
    "costed adjustments both ways",
    [
      { type: MovementType.PURCHASE, quantity: 10, unitCost: 2 },
      { type: MovementType.ADJUSTMENT, quantity: 4, unitCost: 3.5 },
      { type: MovementType.ADJUSTMENT, quantity: -2, unitCost: 3.5 },
    ],
    {},
  ],
  [
    "a manual cost basis and a REPAIR row are inputs; a RECOMPUTE row is not",
    [
      { type: MovementType.PURCHASE, quantity: 10, unitCost: 2 },
      { type: MovementType.COST_BASIS, quantity: 0, unitCost: 9, reference: "RECOMPUTE:ENDPOINT" },
      { type: MovementType.COST_BASIS, quantity: 0, unitCost: 4, reference: null },
      { type: MovementType.PURCHASE, quantity: 10, unitCost: 6 },
      { type: MovementType.COST_BASIS, quantity: 0, unitCost: 7, reference: "B562:REPAIR:h" },
      { type: MovementType.SALE, quantity: -3 },
    ],
    {},
  ],
  [
    "STANDARD carries its frozen average",
    [{ type: MovementType.PURCHASE, quantity: 10, unitCost: 2 }],
    { costingMethod: CostingMethod.STANDARD, averageCost: 1.5 },
  ],
];

describe("foldLedger (row 635, SA-902 MUST 3): one fold, the replay's own", () => {
  it.each(CASES)("parity with the live replay: %s", async (_name, r, opts) => {
    const movements = rows(...r);
    const live = await liveReplay(movements, opts);
    const isStandard = opts?.costingMethod === CostingMethod.STANDARD;
    const folded = foldLedger(movements, {
      isStandard,
      averageCost: opts?.averageCost == null ? null : D(opts.averageCost),
    });
    expect(folded.avg == null ? null : Number(folded.avg)).toBe(live?.newAvgCost ?? null);
    expect(folded.stock.toString()).toBe(
      movements.reduce((s, m) => s.add(m.quantity), D(0)).toString(),
    );
    expect(folded.hasCostfulHistory).toBe(live?.hasCostfulHistory);
  });

  it("the §0 pair folds to the true average; sales-blind folds to 2.0", () => {
    const fold = (r: Row[]) =>
      Number(foldLedger(rows(...r), { isStandard: false, averageCost: null }).avg);
    expect(fold(CASES[0][1])).toBeCloseTo(2.6667, 4);
    expect(fold(CASES[1][1])).toBe(2);
  });

  it("isReplayCorrection needs all three marks (SA-372): a REPAIR row stays an input", () => {
    expect(isReplayCorrection({ type: "COST_BASIS", quantity: 0, reference: "RECOMPUTE:X" })).toBe(
      true,
    );
    expect(
      isReplayCorrection({ type: "COST_BASIS", quantity: 0, reference: "B562:REPAIR:h" }),
    ).toBe(false);
    expect(isReplayCorrection({ type: "COST_BASIS", quantity: 1, reference: "RECOMPUTE:X" })).toBe(
      false,
    );
    expect(isReplayCorrection({ type: "SALE", quantity: 0, reference: "RECOMPUTE:X" })).toBe(false);
  });
});
