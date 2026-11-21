import { billLinesFromPO, buildPOLine, isWholeCents, roundMoney } from "@routeflow/pricing";
import { Prisma } from "@prisma/client";
import { billLinesTotal } from "./bill-lines-total";
import { findPoMatchViolations } from "./po-bill-match";
import { VendorBillsService } from "./vendor-bills.service";

/**
 * SA-1207 P2a, the property test (decision.md spec 3): a bill filled from a PO by `billLinesFromPO`
 * passes the bill-vs-PO check, and a line two cents above BOTH stored figures is refused, for every
 * pack 2-144. Lines go through the service's own `billLineToPieces` (the real conversion both call
 * sites use), then the real `findPoMatchViolations`.
 */
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: jest.fn() } })),
}));
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn(),
  })),
}));

const D = (n: Prisma.Decimal.Value) => new Prisma.Decimal(n);
const svc = VendorBillsService.prototype as unknown as {
  billLineToPieces(item: Record<string, unknown>): any;
};
const toPieces = (l: { qty: number; unitCost: number; packSize: number | null }) =>
  svc.billLineToPieces({ productId: "p1", description: "Widget", ...l });

/** The grids are seeded: the same cells on every run. A failure prints the seed. */
const SEED = 1207;

/** A seeded generator: the grid is the same on every run. */
function lcg(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return Math.floor((s / 4294967296) * n);
  };
}

const CASE_COSTS = [0.07, 0.99, 5, 5.0007, 7.33, 9.9999, 11.99, 12.3457, 48.5, 123.4567];

interface Cell {
  pack: number;
  boxes: number;
  loose: number;
  caseCost: number;
}
function grid(): Cell[] {
  const rand = lcg(SEED);
  const cells: Cell[] = [];
  for (let pack = 2; pack <= 144; pack++) {
    const looseSet = new Set([0, 1, 2, Math.floor(pack / 2), pack - 1, rand(pack), rand(pack)]);
    const boxSet = [0, 1, 2, 5, 13, 99, 250, 500, 1 + rand(499)];
    for (const boxes of boxSet) {
      for (const loose of looseSet) {
        if (boxes === 0 && loose === 0) continue;
        for (const caseCost of CASE_COSTS) cells.push({ pack, boxes, loose, caseCost });
      }
    }
  }
  return cells;
}
const poLineOf = (c: Cell) => ({
  productId: "p1",
  sku: null,
  ...buildPOLine({
    packSize: c.pack,
    caseCost: c.caseCost,
    cases: c.boxes,
    loosePieces: c.loose,
  }),
});
const cellName = (c: Cell) => `${c.boxes}x${c.pack}+${c.loose}@${c.caseCost}`;
const sample = (bad: string[]) => ({ seed: SEED, count: bad.length, first: bad.slice(0, 3) });
const NONE = { seed: SEED, count: 0, first: [] };

describe("SA-1207 P2a: a bill filled from a PO passes the PO check; a line 0.02 over both figures does not", () => {
  const cells = grid();

  it("the grid covers packs 2-144 at 2 and 4 decimal costs", () => {
    expect(new Set(cells.map((c) => c.pack)).size).toBe(143);
    expect(cells.length).toBeGreaterThan(50_000);
  });

  it("worked example: 5 boxes + 2 loose, pack 24, 5.00 a box fills one lot and passes (it was a 409)", () => {
    const po = poLineOf({ pack: 24, boxes: 5, loose: 2, caseCost: 5 });
    expect(po).toMatchObject({ qtyOrdered: 122, unitCost: 0.2083, totalCost: 25.42 });
    const lines = billLinesFromPO([po]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ qty: 1, unitCost: 25.42, packSize: 122 });
    expect(findPoMatchViolations([po], lines.map(toPieces))).toEqual([]);
  });

  it("(a) the bill total equals the stored total, (b) the pieces equal qtyOrdered", () => {
    const bad: string[] = [];
    for (const c of cells) {
      const po = poLineOf(c);
      const lines = billLinesFromPO([po]);
      const pieces = lines.reduce((s, l) => s + l.qty * (l.packSize ?? 1), 0);
      if (billLinesTotal(lines) !== po.totalCost || pieces !== po.qtyOrdered) {
        bad.push(
          `${cellName(c)} total ${billLinesTotal(lines)}/${po.totalCost} pcs ${pieces}/${po.qtyOrdered}`,
        );
      }
    }
    expect(sample(bad)).toEqual(NONE);
  });

  it("(c) the filled bill has no violations against its own PO", () => {
    const bad: string[] = [];
    for (const c of cells) {
      const po = poLineOf(c);
      const v = findPoMatchViolations([po], billLinesFromPO([po]).map(toPieces));
      if (v.length > 0) bad.push(`${cellName(c)} ${v.map((x) => x.reason).join(",")}`);
    }
    expect(sample(bad)).toEqual(NONE);
  });

  it("(d) a piece-line bill at the PO's stored unit cost passes", () => {
    const bad: string[] = [];
    for (const c of cells) {
      const po = poLineOf(c);
      const line = { qty: po.qtyOrdered, unitCost: po.unitCost, packSize: null };
      if (findPoMatchViolations([po], [toPieces(line)]).length > 0) bad.push(cellName(c));
    }
    expect(sample(bad)).toEqual(NONE);
  });

  it("(e) a lot 0.02 above both stored figures is refused", () => {
    const bad: string[] = [];
    for (const c of cells) {
      const po = poLineOf(c);
      const figA = D(po.qtyOrdered).mul(po.unitCost);
      const figB = D(po.totalCost);
      const over = Prisma.Decimal.max(figA, figB).add("0.02").toDecimalPlaces(4);
      const lot = { qty: 1, unitCost: over.toNumber(), packSize: po.qtyOrdered };
      const v = findPoMatchViolations([po], [toPieces(lot)]);
      if (!v.some((x) => x.reason === "PRICE_EXCEEDS_PO")) bad.push(`${cellName(c)} ${over}`);
    }
    expect(sample(bad)).toEqual(NONE);
  });

  it("(e) the same two-cent line is refused when it is typed as boxes at a case cost", () => {
    const bad: string[] = [];
    for (const c of cells.filter((x) => x.loose === 0 && x.boxes > 0)) {
      const po = poLineOf(c);
      const figA = D(po.qtyOrdered).mul(po.unitCost);
      const over = Prisma.Decimal.max(figA, D(po.totalCost))
        .add("0.02")
        .div(c.boxes)
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_UP);
      const line = { qty: c.boxes, unitCost: over.toNumber(), packSize: c.pack };
      if (
        !findPoMatchViolations([po], [toPieces(line)]).some((x) => x.reason === "PRICE_EXCEEDS_PO")
      )
        bad.push(`${cellName(c)} ${over}`);
    }
    expect(sample(bad)).toEqual(NONE);
  });

  // A2: a weighed (fractional) piece line keeps qty x unitCost; whole-piece and boxed lines stay cent-exact.
  describe("weighed lines (fractional quantity) and whole-piece lines", () => {
    const rand = lcg(SEED + 1);
    const piece = (qty: number, unitCost: number, i: number) => ({
      ...buildPOLine({ qtyOrdered: qty, unitCost }),
      productId: `w${i}`,
      sku: null,
    });
    const weighed = (i: number) => {
      const qty = (1 + rand(99_999)) / 1000;
      return piece(Number.isInteger(qty) ? qty + 0.001 : qty, (1 + rand(999_999)) / 10_000, i);
    };
    const whole = (i: number) => piece(1 + rand(500), (1 + rand(999_999)) / 10_000, i);
    const toBill = (po: ReturnType<typeof piece>[]) => billLinesFromPO(po);

    it("a fractional line is the plain piece line qty x unitCost and passes check X", () => {
      const bad: string[] = [];
      for (let i = 0; i < 3000; i++) {
        const po = weighed(i);
        const lines = toBill([po]);
        const ok =
          lines.length === 1 &&
          lines[0].qty === po.qtyOrdered &&
          lines[0].unitCost === po.unitCost &&
          lines[0].packSize === null &&
          lines[0].unitLabel === null;
        const v = findPoMatchViolations([po], lines.map(toPieces));
        if (!ok || v.length > 0) bad.push(`${po.qtyOrdered}@${po.unitCost}`);
      }
      expect(sample(bad)).toEqual(NONE);
    });

    it("a whole-piece line stays cent-exact and passes check X", () => {
      const bad: string[] = [];
      for (let i = 0; i < 3000; i++) {
        const po = whole(i);
        const lines = toBill([po]);
        const pieces = lines.reduce((t, l) => t + l.qty * (l.packSize ?? 1), 0);
        const v = findPoMatchViolations([po], lines.map(toPieces));
        if (billLinesTotal(lines) !== po.totalCost || pieces !== po.qtyOrdered || v.length > 0)
          bad.push(`${po.qtyOrdered}@${po.unitCost}`);
      }
      expect(sample(bad)).toEqual(NONE);
    });

    it("a mixed bill: no violations, and the total is within 0.005 a fractional line that is not whole cents", () => {
      const bad: string[] = [];
      for (let b = 0; b < 600; b++) {
        const po = [
          ...Array.from({ length: 1 + rand(5) }, (_, i) => weighed(b * 20 + i)),
          ...Array.from({ length: rand(3) }, (_, i) => whole(b * 20 + 10 + i)),
          poLineOf(cells[rand(cells.length)]),
        ].map((l, i) => ({ ...l, productId: `m${i}` }));
        const lines = toBill(po);
        const v = findPoMatchViolations(
          po,
          lines.map((l) => ({ ...toPieces(l), productId: l.productId })),
        );
        const stored = roundMoney(po.reduce((t, l) => t + l.totalCost, 0));
        const m = po.filter(
          (l) => !Number.isInteger(l.qtyOrdered) && !isWholeCents(l.qtyOrdered * l.unitCost),
        ).length;
        const off = Math.abs(roundMoney(billLinesTotal(lines) - stored));
        if (v.length > 0 || off > roundMoney(0.005 * m) + 1e-9)
          bad.push(`bill ${b}: off ${off} m ${m}`);
      }
      expect(sample(bad)).toEqual(NONE);
    });
  });

  it("roundMoney is the only rounding a filled line carries (every cost is whole cents or the case cost)", () => {
    const po = poLineOf({ pack: 24, boxes: 5, loose: 0, caseCost: 5 });
    const [line] = billLinesFromPO([po]);
    expect(line).toMatchObject({ qty: 5, unitCost: 5, packSize: 24, unitLabel: null });
    expect(roundMoney(line.qty * line.unitCost)).toBe(po.totalCost);
  });
});
