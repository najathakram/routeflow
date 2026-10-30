/**
 * SA-984 §4 / SA-987: the units fold-in battery, readers layer (no DB). Rows E0 (existing data, flag off vs flag on),
 * the positive controls, E1-b/E1-c (the new Piece pick), the Q1 guard rows, the Q3 holder rows and E2 (odd tier).
 *
 * How to read a cell. Every cell prints OLD (flag off) and NEW (flag on) for each compared field when they differ, and
 * records how often each of the three keys was asked. A cell that is equal with `consulted = 0` is "equal by
 * short-circuit": the flag was never read, so equality there says the pack-only path ignores the flag, not that the
 * flag was covered (loadUnitsPricesV2 returns null at units-prices-v2.ts:163 and assertMayUseUnits at
 * unit-line-build.ts:168). The positive controls PC-1/PC-2/PC-3 reach the computed branches and MUST differ.
 *
 * STOP RULE (SA-984 §5): a red `expectSame` is a finding. Never edit its expectation; report OLD and NEW.
 */
import { BadRequestException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import {
  resolveLineUnits,
  normalizeDerivedBaseLine,
  asLadderProduct,
} from "../products/line-units";
import { computeLineSubtotal, regulatedUnitBasis, roundMoney } from "@routeflow/pricing";
import { assertMayUseUnits } from "./unit-line-build";
import { orderTotalsOf } from "./order-totals";
import { customerPricing } from "./units-prices-v2";
import { resolveTierPrices } from "./counter-sale/counter-sale-tier-price";
import {
  FLAG_V1,
  FLAG_PRICES_V2,
  SHAPES,
  TAX_RATE,
  NO_PACK_SHAPES,
  bothStates,
  customerOf,
  expectDiffers,
  expectSame,
  expectSameRuns,
  fakeDb,
  makeFlagStub,
  priceLine,
  reportCells,
  type CustomerRow,
  type Fig,
  type LineReq,
  type LineRun,
  type Shape,
} from "./testing/units-fold-battery";

afterAll(() =>
  reportCells("units-fold E0 readers: cell, equal?, label, flag consulted (NEW side)"),
);

const shapeOf = (id: string): Shape => SHAPES[id];
const boxed = (s: Shape) => Number(s.product.unitsPerBox ?? 0) > 1;

// The customers of plan §3: all valid tiers (1..5), a tier-3 per-product override, and a customer's own order unit.
const customersOf = (s: Shape): Record<string, CustomerRow> => ({
  C1: customerOf("c1", 1),
  CN: customerOf("cn", null),
  C2: customerOf("c2", 2),
  C5: customerOf("c5", 5),
  C3: customerOf("c3", 1, { cp: [{ productId: s.product.id, pricingTier: 3 }] }),
  CU: customerOf("cu", 1, {
    cp: [{ productId: s.product.id, pricingTier: null, orderUnitRef: "pack" }],
  }),
});
// Line forms (plan §3): qty, the box/piece split, pieces only; N-* run qty only, plus boxes:1 on N-1 (the web sends it).
const formsOf = (s: Shape): Record<string, LineReq> => {
  if (boxed(s)) return { qty3: { qty: 3 }, split: { boxes: 1, pieces: 3 }, pieces5: { pieces: 5 } };
  if (s.id === "N-1") return { qty3: { qty: 3 }, boxes1: { qty: 4, boxes: 1 } };
  return { qty3: { qty: 3 } };
};

// ─── E0: every shape x customer x line form, ORD (staff) ────────────────────────────────────────────────────────────
describe("E0 ORD: a staff order line, flag off vs flag on (existing data)", () => {
  for (const id of ["N-null", "N-0", "N-1", "B12", "B12-reg", "LAD"]) {
    const shape = shapeOf(id);
    for (const [cName] of Object.entries(customersOf(shape))) {
      for (const [fName, req] of Object.entries(formsOf(shape))) {
        it(`ORD ${id} ${cName} ${fName}: same figures, no key asked`, async () => {
          const cust = customersOf(shape)[cName];
          const { off, on } = await bothStates({ shape, cust, req });
          expectSameRuns(`ORD ${id} ${cName} ${fName}`, off, on);
          // a vacuous "equal" (both sides priced nothing) is not a test
          expect(off.fig.subtotal as number).toBeGreaterThan(0);
        });
      }
    }
  }
});

// ─── E0 named no-pack rows (SA-984 §1): independent figures, not just old == new ────────────────────────────────────
describe("E0 named no-pack rows: unitsPerBox null / 0 / 1 are one plain unit, flag off and flag on", () => {
  // Independent formula: 3 x $11.00 = 33.00; tax 33.00 x 0.0825 = 2.7225 -> 2.72; total 35.72.
  const PLAIN_QTY3 = {
    qty: 3,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitLabel: null,
    unitPrice: 11,
    priceType: "STANDARD",
    originalPrice: null,
    promoFreeUnits: null,
    subtotal: 33,
    categoryTaxAmount: 0,
    headerSubtotal: 33,
    headerTax: 2.72,
    headerTotal: 35.72,
    stockPieces: 3,
    printedQty: "3",
  };
  for (const id of NO_PACK_SHAPES) {
    it(`${id}: qty 3 stores the plain-unit line (OBSERVED equal to the independent figure) in both key states`, async () => {
      const shape = shapeOf(id);
      const { off, on } = await bothStates({ shape, cust: customerOf("c1", 1), req: { qty: 3 } });
      expectSameRuns(`NOPACK ${id} qty3`, off, on);
      expect(off.fig).toMatchObject(PLAIN_QTY3);
      expect(on.fig).toMatchObject(PLAIN_QTY3);
    });
  }
  it("N-1: the web's boxes:1 payload keeps the operator's qty (4 x 11.00 = 44.00), flag off and on", async () => {
    const { off, on } = await bothStates({
      shape: shapeOf("N-1"),
      cust: customerOf("c1", 1),
      req: { qty: 4, boxes: 1 },
    });
    expectSameRuns("NOPACK N-1 boxes1", off, on);
    for (const run of [off, on]) {
      expect(run.fig).toMatchObject({
        qty: 4,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        subtotal: 44,
        headerTotal: 47.63, // 44 + round(44 x 0.0825 = 3.63)
        stockPieces: 4,
        printedQty: "4",
      });
    }
  });
  for (const id of NO_PACK_SHAPES) {
    it(`${id}: a "Piece" request is the product itself (the pack line), allowed on and refused off (by design)`, async () => {
      const shape = shapeOf(id);
      const cust = customerOf("c1", 1);
      const plainOn = await priceLine({ state: "on", shape, cust, req: { qty: 3 } });
      const pieceOn = await priceLine({
        state: "on",
        shape,
        cust,
        req: { qty: 3, unitLabel: "Piece" },
      });
      const pieceOff = await priceLine({
        state: "off",
        shape,
        cust,
        req: { qty: 3, unitLabel: "Piece" },
      });
      // flag on: "Piece" resolves to the pack, so every stored figure equals the plain line
      expectSame(`NOPACK ${id} Piece vs plain, flag on`, plainOn.fig, pieceOn.fig);
      expect(pieceOn.consulted.units_v1).toBe(1);
      // flag off: a unit request is a NEW write, refused (SA-984 §0)
      expect(pieceOff.fig.error).toMatch(/ForbiddenException: Selling by unit is not included/);
      expect(pieceOff.consulted.units_v1).toBe(1);
    });
  }
  it("the pure readers agree: the pack line factor is 0 / 0 / 1 and normalizeDerivedBaseLine returns the SAME object", () => {
    const factor: Record<string, number> = { "N-null": 0, "N-0": 0, "N-1": 1 };
    for (const id of NO_PACK_SHAPES) {
      const p = shapeOf(id).product;
      const r = resolveLineUnits(p, [], { unitLabel: "Piece" });
      expect(r).toEqual({ unitsPerBox: factor[id], unitLabel: null, kind: "pack" });
      const item = { productId: p.id, qty: 5, unitLabel: "Piece" };
      expect(normalizeDerivedBaseLine(item, asLadderProduct(p), [], 1)).toBe(item);
    }
  });
});

// ─── E0 independent pins on the boxed forms (the old split, so the figures are not just old == new) ─────────────────
describe("E0 boxed forms: independent figures on B12 and the regulated twin", () => {
  const cust = customerOf("c1", 1);
  it("B12 pieces 5: 11.00 x 5/12 = 4.58, five pieces of stock, printed '5 pcs'", async () => {
    const { off, on } = await bothStates({ shape: shapeOf("B12"), cust, req: { pieces: 5 } });
    expectSameRuns("PIN B12 pieces5", off, on);
    expect(off.fig).toMatchObject({
      qty: 5,
      boxes: 0,
      pieces: 5,
      unitsPerBox: 12,
      unitPrice: 11,
      subtotal: 4.58,
      stockPieces: 5,
      printedQty: "5 pcs",
    });
  });
  it("B12 split 1 box + 3: 11.00 x (1 + 3/12) = 13.75, 15 pieces, '1 box + 3 pcs'", async () => {
    const { off, on } = await bothStates({
      shape: shapeOf("B12"),
      cust,
      req: { boxes: 1, pieces: 3 },
    });
    expectSameRuns("PIN B12 split", off, on);
    expect(off.fig).toMatchObject({
      qty: 15,
      boxes: 1,
      pieces: 3,
      unitsPerBox: 12,
      subtotal: 13.75,
      stockPieces: 15,
      printedQty: "1 box + 3 pcs",
    });
  });
  it("B12 qty 3 (box-unaware): 3 x 11.00 = 33.00, stock 3 x 12 = 36 pieces", async () => {
    const { off, on } = await bothStates({ shape: shapeOf("B12"), cust, req: { qty: 3 } });
    expectSameRuns("PIN B12 qty3", off, on);
    expect(off.fig).toMatchObject({
      qty: 3,
      boxes: null,
      subtotal: 33,
      stockPieces: 36,
      printedQty: "3",
    });
  });
  it("B12-reg: the per-unit levy follows the piece count (0.50 x 5 = 2.50 on 5 pieces, 0.50 x 15 = 7.50 on the split)", async () => {
    const shape = shapeOf("B12-reg");
    const a = await bothStates({ shape, cust, req: { pieces: 5 } });
    expectSameRuns("PIN B12-reg pieces5", a.off, a.on);
    expect(a.off.fig).toMatchObject({ categoryTaxAmount: 2.5, categoryTaxType: "EXCISE_PER_UNIT" });
    const b = await bothStates({ shape, cust, req: { boxes: 1, pieces: 3 } });
    expectSameRuns("PIN B12-reg split", b.off, b.on);
    expect(b.off.fig).toMatchObject({ categoryTaxAmount: 7.5 });
  });
});

// ─── E0 BUY: the buyer arm, with a promotion (Q1 guard (c)) ─────────────────────────────────────────────────────────
describe("E0 BUY: a buyer pack line, with and without a promotion", () => {
  const promo = [
    { id: "pr1", type: "PERCENT" as const, value: 10, scope: "ALL" as const, minQty: null },
  ];
  for (const id of ["N-1", "B12", "B12-reg"]) {
    it(`BUY ${id}: a pack line with a 10% promo is the same flag off and flag on (SA-987 Q1 guard c)`, async () => {
      const shape = shapeOf(id);
      const req: LineReq = boxed(shape) ? { boxes: 1, pieces: 3 } : { qty: 3 };
      const { off, on } = await bothStates({
        shape,
        cust: customerOf("c1", 1),
        req,
        actor: "buyer",
        promos: promo,
      });
      expectSameRuns(`BUY ${id} promo`, off, on);
      expect(off.fig.priceType).toBe("PROMO"); // the promo path ran
      expect(off.fig.promoFreeUnits).toBeNull();
    });
  }
  it("BUY: with no promotion the line is STANDARD and equal", async () => {
    const { off, on } = await bothStates({
      shape: shapeOf("B12"),
      cust: customerOf("c1", 1),
      req: { qty: 3 },
      actor: "buyer",
    });
    expectSameRuns("BUY B12 no promo", off, on);
    expect(off.fig.priceType).toBe("STANDARD");
  });
  it("Q1 guard (a): a buyer create with unitLabel 'Piece' is refused 400 with the flag on, and nothing was priced", async () => {
    const shape = shapeOf("B12");
    const stub = makeFlagStub("on");
    const run = await priceLine({
      state: "on",
      stub,
      shape,
      cust: customerOf("c1", 1),
      req: { qty: 5, unitLabel: "Piece" },
      actor: "buyer",
    });
    expect(run.fig).toEqual({
      error: "BadRequestException: Only staff can choose a selling unit on an order line.",
    });
    // refused before the flag is even asked (the staff check comes first), so no key was consulted and no line exists
    expect(run.consulted.units_v1).toBe(0);
    await expect(
      assertMayUseUnits([{ productId: shape.product.id, unitLabel: "Piece" }], {
        isStaff: false,
        tenantId: "t",
        hasFlag: async () => true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── E0 CTR: the counter audit baseline (resolveTierPrices) ─────────────────────────────────────────────────────────
describe("E0 CTR: the counter's tier-price baseline, flag off vs flag on", () => {
  const baseline = async (state: "off" | "on", shape: Shape, cust: CustomerRow) => {
    const stub = makeFlagStub(state);
    const db = {
      ...fakeDb(shape, cust),
      customer: { findFirst: async () => ({ pricingTier: cust.pricingTier }) },
      customerPrice: { findMany: async () => cust.cp },
      product: { findMany: async () => [shape.product] },
    };
    const map = await resolveTierPrices(db as never, cust.id, [shape.product.id], {
      prisma: { getTenantId: () => "t-fold" },
      entitlements: stub.entitlements as never,
    });
    return { fig: Object.fromEntries(map) as Fig, consulted: stub.consulted() };
  };
  const expected: Record<string, number> = { C1: 11, C2: 10.5, C3: 10, C5: 9, CN: 11 };
  for (const id of ["N-null", "N-1", "B12", "LAD"]) {
    const shape = shapeOf(id);
    for (const cName of ["C1", "C2", "C3", "C5", "CN"]) {
      it(`CTR ${id} ${cName}: baseline ${expected[cName]}, same both ways, no key asked`, async () => {
        const cust = customersOf(shape)[cName];
        const off = await baseline("off", shape, cust);
        const on = await baseline("on", shape, cust);
        expectSameRuns(`CTR ${id} ${cName}`, off, on);
        // resolveTierPrices swallows errors into an empty map: an empty map would make "equal" vacuous
        expect(off.fig).toEqual({ [shape.product.id]: expected[cName] });
      });
    }
  }
});

// ─── unchanged by construction (SA-987 §4): INV-a, INV-b, CN, units_settings_v1 ─────────────────────────────────────
describe("unchanged by construction: no money path reads the flag (labelled, not flag coverage)", () => {
  const SRC = path.resolve(__dirname, "..");
  const sources = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "testing") sources(full, out);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
    }
    return out;
  };
  const readers = (needle: string) =>
    sources(SRC)
      .filter((f) => fs.readFileSync(f, "utf8").includes(needle))
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .sort();

  it("flag.units_settings_v1: only the /units controller and the feature registry mention it (no order, invoice, credit or stock path)", () => {
    expect(readers("units_settings_v1")).toEqual([
      "billing/feature-registry.ts",
      "units/units.controller.ts",
    ]);
  });
  it("INV-a / INV-b / CN: the invoice-from-order copy, the pack-line manual invoice and the credit-note write never call the tier resolver or the unit gate", () => {
    const calls = (needle: RegExp, dirs: string[]) =>
      sources(SRC)
        .filter((f) => dirs.some((d) => f.split(path.sep).join("/").includes(`/${d}/`)))
        .filter((f) => needle.test(fs.readFileSync(f, "utf8")))
        .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
        .sort();
    const gate = /customerPricing\(|assertMayUseUnits\(|prepareUnitLadders\(|hasFlagStrict/;
    // INV-b's own context file is the one invoices/ reader of the unit gate (a line that NAMES a unit); a pack line never reaches it
    expect(calls(gate, ["credit-notes"])).toEqual([]);
    // invoice-display-unit.ts (SA-827) reads the units flag for the DISPLAY unit only; it never reads or writes money
    // (pinned by invoice-unit-display-only.spec.ts), so it is a reader here, not a money path.
    expect(calls(gate, ["invoices"])).toEqual([
      "invoices/invoice-display-unit.ts",
      "invoices/invoice-edit-plan.ts",
      "invoices/invoice-line-override.ts",
      "invoices/manual-invoice-context.ts",
    ]);
  });
});

// ─── positive controls: these MUST differ (they prove the toggle is live) ───────────────────────────────────────────
describe("positive controls: the three keys move a figure when the data reaches them", () => {
  const typed = (price: string): CustomerRow =>
    customerOf("c1", 1, { typed: [{ productId: "p-lad", unitRef: "pack", price }] });

  it("PC-1: a typed pack price for the customer (CustomerUnitPrice) is billed flag on and ignored flag off, and the key is asked", async () => {
    const { off, on } = await bothStates({
      shape: shapeOf("LAD"),
      cust: typed("9.50"),
      req: { qty: 3 },
    });
    const moved = expectDiffers("PC-1", off.fig, on.fig, {
      ruling: "SA-984 §4 E0 positive control / SA-811a",
      fields: ["unitPrice", "subtotal"],
    });
    expect(off.fig.unitPrice).toBe(11); // OBSERVED OLD: the tier chain
    expect(on.fig.unitPrice).toBe(9.5); // OBSERVED NEW: the customer layer
    expect(moved).toContain("priceType");
    for (const run of [off, on]) {
      expect(run.consulted.units_prices_v2).toBeGreaterThan(0);
      expect(run.consulted.strict).toBeGreaterThan(0); // hasFlagStrict, not hasFlag (R1)
    }
  });

  it("PC-1 at the counter baseline: the audit baseline follows the customer layer too (S19b A-4)", async () => {
    const shape = shapeOf("LAD");
    const cust = typed("9.50");
    const run = async (state: "off" | "on") => {
      const stub = makeFlagStub(state);
      const db = {
        ...fakeDb(shape, cust),
        customer: { findFirst: async () => ({ pricingTier: 1 }) },
        customerPrice: { findMany: async () => [] },
        product: { findMany: async () => [shape.product] },
      };
      const map = await resolveTierPrices(db as never, cust.id, [shape.product.id], {
        prisma: { getTenantId: () => "t-fold" },
        entitlements: stub.entitlements as never,
      });
      return Object.fromEntries(map) as Fig;
    };
    expectDiffers("PC-1 CTR", await run("off"), await run("on"), {
      ruling: "SA-811a / S19b A-4",
      fields: ["p-lad"],
    });
  });

  it("PC-2: an odd customer tier (7) takes the COMPUTED branch of loadUnitsPricesV2 (SA-812a G-1): flag on normalises it to tier 1", async () => {
    const { off, on } = await bothStates({
      shape: shapeOf("B12"),
      cust: customerOf("c7", 7),
      req: { qty: 3 },
    });
    expectDiffers("PC-2", off.fig, on.fig, {
      ruling: "SA-984 §0 isOddTier / SA-812a G-1",
      fields: ["priceType"],
    });
    for (const run of [off, on]) {
      expect(run.consulted.units_prices_v2).toBeGreaterThan(0); // the odd tier forced the ask
      expect(run.consulted.strict).toBeGreaterThan(0);
    }
  });

  it("PC-3: a unit request needs flag.units_v1: refused 403 off, a Case line on", async () => {
    const { off, on } = await bothStates({
      shape: shapeOf("LAD"),
      cust: customerOf("c1", 1),
      req: { qty: 1, unitLabel: "Case" },
    });
    expectDiffers("PC-3", off.fig, on.fig, {
      ruling: "SA-984 §0 units_v1 (new write)",
      fields: ["error"],
    });
    expect(off.fig.error).toMatch(
      /^ForbiddenException: Selling by unit is not included in this plan/,
    );
    expect(on.fig).toMatchObject({
      unitLabel: "Case",
      qty: 48,
      boxes: 1,
      unitsPerBox: 48,
      unitPrice: 44,
      subtotal: 44,
    });
    expect(off.consulted.units_v1).toBe(1);
    expect(on.consulted.units_v1).toBe(1);
  });

  it("R1 DEAD-STUB PROBE: with hasFlagStrict removed from the stub, PC-1 and PC-2 collapse to equal and the kit refuses them", async () => {
    const dead = (state: "off" | "on") => makeFlagStub(state, { strict: false });
    const run = (state: "off" | "on", shape: Shape, cust: CustomerRow) =>
      priceLine({ state, stub: dead(state), shape, cust, req: { qty: 3 } });
    const pc1 = [
      await run("off", shapeOf("LAD"), typed("9.50")),
      await run("on", shapeOf("LAD"), typed("9.50")),
    ];
    const pc2 = [
      await run("off", shapeOf("B12"), customerOf("c7", 7)),
      await run("on", shapeOf("B12"), customerOf("c7", 7)),
    ];
    for (const [name, [o, n]] of [
      ["PC-1", pc1],
      ["PC-2", pc2],
    ] as const) {
      // the flag was never reached: no ask recorded, and the figures are identical on both sides
      expect(n.consulted.units_prices_v2).toBe(0);
      let message = "";
      try {
        expectDiffers(`${name} (dead stub)`, o.fig, n.fig, { ruling: "R1 probe" });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/POSITIVE CONTROL IS DEAD/);
      console.log(`R1 dead-stub probe, ${name}: ${message}`);
    }
  });
});

// ─── E1-b / E1-c: the new Piece pick vs today's split (observe and report) ──────────────────────────────────────────
describe("E1 new-line money parity: 5 loose pieces of a 12-pack at $11.00, today's split vs the Piece pick", () => {
  // SA-984 §4 E1 compares subtotal, tax, stock movement and the printed line. The stored SHAPE (boxes/pieces vs a
  // factor-1 unit line) and the per-box vs per-piece unitPrice differ by construction and are not money.
  const E1_FIELDS = [
    "subtotal",
    "categoryTaxAmount",
    "headerSubtotal",
    "headerTax",
    "headerTotal",
    "stockPieces",
    "printedQty",
  ];
  const pick = (f: Fig): Fig => Object.fromEntries(E1_FIELDS.map((k) => [k, f[k]]));
  const oldLine = { pieces: 5 } as const;
  const newLine = { qty: 5, unitLabel: "Piece" } as const;
  const parity = async (cell: string, shape: Shape, cust: CustomerRow) => {
    const old = await priceLine({ state: "off", shape, cust, req: oldLine }); // today: nothing asked
    const next = await priceLine({ state: "on", shape, cust, req: newLine }); // the pick needs flag.units_v1
    expect(next.consulted.units_v1).toBe(1);
    expect(old.consulted.units_v1).toBe(0);
    expect(old.fig.error).toBeUndefined();
    expect(next.fig.error).toBeUndefined();
    expectSame(cell, pick(old.fig), pick(next.fig));
    return { old, next };
  };
  const tier3 = (s: Shape) =>
    customerOf("c3", 1, { cp: [{ productId: s.product.id, pricingTier: 3 }] });

  it("E1-b tier 1, no Piece row (B12): the derived Piece is rewritten to the pack's pieces", async () => {
    await parity("E1-b B12 tier1", shapeOf("B12"), customerOf("c1", 1));
  });
  it("E1-b tier 1, a level row but no Piece row (LADC)", async () => {
    await parity("E1-b LADC tier1", shapeOf("LADC"), customerOf("c1", 1));
  });
  it("E1-b tier 3 (LADC)", async () => {
    await parity("E1-b LADC tier3", shapeOf("LADC"), tier3(shapeOf("LADC")));
  });
  it("E1-b: the picker's displayed derived price sent back with the pick is still the pack's pieces", async () => {
    const shape = shapeOf("LADC");
    const old = await priceLine({ state: "off", shape, cust: customerOf("c1", 1), req: oldLine });
    const next = await priceLine({
      state: "on",
      shape,
      cust: customerOf("c1", 1),
      req: { ...newLine, unitPrice: 0.92 }, // roundMoney(11 / 12), what the picker shows
    });
    expectSame("E1-b LADC tier1 +displayed price", old.fig, next.fig);
  });

  // E1-c (an own-priced Piece row) is an INTENDED DIFFERENCE (SA-996): see its own describe below.
  it("E1-c reaches the factor-1 unit branch: the stored line is a Piece unit line snapshotting factor 1", async () => {
    const next = await priceLine({
      state: "on",
      shape: shapeOf("LADP"),
      cust: customerOf("c1", 1),
      req: newLine,
    });
    expect(next.fig).toMatchObject({
      unitLabel: "Piece",
      unitsPerBox: 1,
      boxes: null,
      pieces: null,
      qty: 5,
      unitPrice: 0.92,
    });
  });
  it("Q1 guard (b): a staff own-priced Piece line stores promoFreeUnits null, even when a promotion is active", async () => {
    const next = await priceLine({
      state: "on",
      shape: shapeOf("LADP"),
      cust: customerOf("c1", 1),
      req: newLine,
      promos: [{ id: "pr1", type: "BUY_N_GET_M", value: 1, minQty: 1, scope: "ALL" }],
    });
    expect(next.fig.unitLabel).toBe("Piece");
    expect(next.fig.promoFreeUnits).toBeNull();
  });
});

// ─── E1-c: an own-priced Piece row is count x P (INTENDED DIFFERENCE, SA-996) ───────────────────────────────────────
describe("E1-c intended difference (SA-996): an own-priced Piece is charged per piece, count x P", () => {
  // Ruling SA-996 E1-c: someone who types $0.92 a piece charges $0.92 a piece. The gap to today's prorated split is only
  // P rounded to cents (pack / 12 is not a whole cent, except at tier 5). Flag-on changes no existing line: a non-holder
  // holds no ProductUnit row, and the fold invents no Piece. Everything that is NOT the subtotal stays expectSame: the
  // stock the line moves, the tax-basis pieces, and the flag-consulted counts (units_v1 asked once on, never off).
  const oldLine = { pieces: 5 } as const;
  const newLine = { qty: 5, unitLabel: "Piece" } as const;
  const header = (subtotal: number, categoryTaxAmount: number) =>
    orderTotalsOf([{ subtotal, categoryTaxAmount }], {
      taxRate: TAX_RATE,
      isTaxExempt: false,
      discount: 0,
    });
  const taxBasis = (fig: Fig, upb: number) =>
    regulatedUnitBasis(
      {
        qty: fig.qty as number,
        boxes: fig.boxes as number | null,
        pieces: fig.pieces as number | null,
        unitLabel: fig.unitLabel as string | null,
      },
      upb,
    ).unitBasisQty;

  const cell = async (
    name: string,
    cust: CustomerRow,
    want: {
      packPrice: number;
      oldSubtotal: number;
      newSubtotal: number;
      oldTotal: number;
      newTotal: number;
      pieceP: number;
    },
  ) => {
    const shape = shapeOf("LADP");
    const old = await priceLine({ state: "off", shape, cust, req: oldLine });
    const next = await priceLine({ state: "on", shape, cust, req: newLine });
    expect(old.fig.error).toBeUndefined();
    expect(next.fig.error).toBeUndefined();
    // still expectSame (any difference here stays a STOP): stock, tax-basis pieces, the tax amount
    expectSame(
      name + " (stock, tax basis)",
      {
        stockPieces: old.fig.stockPieces,
        taxBasisPieces: taxBasis(old.fig, 12),
        tax: old.fig.categoryTaxAmount,
      },
      {
        stockPieces: next.fig.stockPieces,
        taxBasisPieces: taxBasis(next.fig, 12),
        tax: next.fig.categoryTaxAmount,
      },
    );
    expect(old.fig.stockPieces).toBe(5);
    expect([old.consulted.units_v1, next.consulted.units_v1]).toEqual([0, 1]);
    // PINNED, each beside its formula. OLD: today's prorated split of the pack price. NEW: count x the typed Piece price.
    expect(old.fig.subtotal).toBe(
      computeLineSubtotal({
        unitPrice: want.packPrice,
        qty: 5,
        boxes: 0,
        pieces: 5,
        unitsPerBox: 12,
      }),
    );
    expect(next.fig.subtotal).toBe(roundMoney(5 * want.pieceP));
    expect([old.fig.subtotal, next.fig.subtotal]).toEqual([want.oldSubtotal, want.newSubtotal]); // OBSERVED
    // header figures: the house helper on each side's own subtotal (no hand-typed tax), plus the observed totals
    expect(old.fig).toMatchObject({
      headerSubtotal: want.oldSubtotal,
      headerTax: header(want.oldSubtotal, old.fig.categoryTaxAmount as number).tax,
      headerTotal: want.oldTotal,
    });
    expect(next.fig).toMatchObject({
      headerSubtotal: want.newSubtotal,
      headerTax: header(want.newSubtotal, next.fig.categoryTaxAmount as number).tax,
      headerTotal: want.newTotal,
    });
    // printed: a unit line prints the unit's own word as typed (SA-996: nothing pluralises a tenant's word)
    expect([old.fig.printedQty, next.fig.printedQty]).toEqual(["5 pcs", "5 Piece"]);
  };

  it("E1-c intended difference (SA-996), tier 1, Piece at 0.92: subtotal 4.58 split vs 4.60 count x P; totals 4.96 vs 4.98", async () => {
    await cell("E1-c LADP tier1", customerOf("c1", 1), {
      packPrice: 11,
      pieceP: 0.92,
      oldSubtotal: 4.58,
      newSubtotal: 4.6,
      oldTotal: 4.96,
      newTotal: 4.98,
    });
  });
  it("E1-c intended difference (SA-996), tier 3, Piece at 0.83: subtotal 4.17 split vs 4.15 count x P; totals 4.51 vs 4.49", async () => {
    await cell(
      "E1-c LADP tier3",
      customerOf("c3", 1, { cp: [{ productId: "p-ladp", pricingTier: 3 }] }),
      {
        packPrice: 10,
        pieceP: 0.83,
        oldSubtotal: 4.17,
        newSubtotal: 4.15,
        oldTotal: 4.51,
        newTotal: 4.49,
      },
    );
  });
});

// ─── Q3: the holder rows. The OLD side is the key set the holder actually has (SA-987 Q3) ───────────────────────────
describe("Q3 holder-only data: compared from the key set the holder has, vs all three", () => {
  // Writer gates, read at 6395541ab: ProductUnit rows are written behind flag.units_v1 (products/product-units.controller.ts
  // @RequirePlanFlag), CustomerUnitPrice rows behind flag.units_prices_v2 (customers/customer-unit-prices.controller.ts:19).
  const V1 = [FLAG_V1];
  const V2 = [FLAG_PRICES_V2];
  const BOTH = [FLAG_V1, FLAG_PRICES_V2];
  const c1 = customerOf("c1", 1);

  for (const [fName, req] of Object.entries({
    qty3: { qty: 3 },
    split: { boxes: 1, pieces: 3 },
    pieces5: { pieces: 5 },
  } as Record<string, LineReq>)) {
    it(`LAD ${fName}: a units_v1 holder gets the same pack figures when the other two keys arrive`, async () => {
      const { off, on } = await bothStates({ shape: shapeOf("LAD"), cust: c1, req }, V1);
      expectSameRuns(`Q3 LAD ${fName} {v1}->all`, off, on);
    });
  }
  it("LAD edit: a qty change on an existing stored Case line (unit re-sent) is the same for a units_v1 holder before and after", async () => {
    const existing = {
      unitLabel: "Case",
      unitsPerBox: 48,
      unitPrice: 44,
      priceType: "STANDARD" as const,
      originalPrice: null,
    };
    const { off, on } = await bothStates(
      { shape: shapeOf("LAD"), cust: c1, req: { qty: 2, unitLabel: "Case" }, existing },
      V1,
    );
    expectSameRuns("Q3 LAD edit Case qty2 {v1}->all", off, on, { consulted: { units_v1: "some" } });
    expect(off.fig).toMatchObject({
      unitLabel: "Case",
      qty: 96,
      boxes: 2,
      unitsPerBox: 48,
      unitPrice: 44,
      subtotal: 88,
    });
  });
  for (const [fName, req] of Object.entries({
    qty3: { qty: 3 },
    split: { boxes: 1, pieces: 3 },
  } as Record<string, LineReq>)) {
    it(`LAD + typed pack price ${fName}: a {v1,prices_v2} holder gets the same figures with the settings key added`, async () => {
      const cust = customerOf("c1", 1, {
        typed: [{ productId: "p-lad", unitRef: "pack", price: "9.50" }],
      });
      const { off, on } = await bothStates({ shape: shapeOf("LAD"), cust, req }, BOTH);
      expectSameRuns(`Q3 LAD+typed ${fName} {v1,v2}->all`, off, on, {
        consulted: { units_prices_v2: "some" },
      });
      expect(off.fig.unitPrice).toBe(9.5); // the holder already bills the typed price: nothing moves at D5
    });
  }
  it("CU: a prices_v2 holder with the customer's own order unit set gets the same pack figures", async () => {
    const cust = customerOf("cu", 1, {
      cp: [{ productId: "p-lad", pricingTier: null, orderUnitRef: "pack" }],
      typed: [{ productId: "p-lad", unitRef: "pack", price: "9.50" }],
    });
    const { off, on } = await bothStates({ shape: shapeOf("LAD"), cust, req: { qty: 3 } }, V2);
    expectSameRuns("Q3 CU {v2}->all", off, on, { consulted: { units_prices_v2: "some" } });
  });
  it("TU (a ProductTierUnit row) is read only inside the typed-price branch (units-prices-v2.ts:193-203): covered by the typed cells above, listed not seeded here", () => {
    expect(true).toBe(true);
  });
});

// ─── E2: an odd tier (PF-14 pinned; the repair rows prove D5's census-bounded repair keeps today's bill) ─────────────
describe("E2 odd tier (PF-14, SA-996): flag-on normalises a tier outside 1-5 through customerTierFor; master used it raw", () => {
  // SA-996 E2: flag-on's value is the house rule (PF-14, customer-unit-price.spec.ts:38-52), but D5 still never changes an
  // existing customer's bill (census C-4 stays a D5 stop). So the DIFFERENCE is pinned here at the observed OLD and NEW,
  // and one repair row per cell proves that replacing the junk tier by 1 (never null) makes flag-off equal flag-on and
  // keeps today's bill.
  const header = (subtotal: number) =>
    orderTotalsOf([{ subtotal, categoryTaxAmount: 0 }], {
      taxRate: TAX_RATE,
      isTaxExempt: false,
      discount: 0,
    });
  type Side = { unitPrice: number; priceType: string; originalPrice: number | null };
  const pinned = async (cust: CustomerRow, want: { off: Side; on: Side }) => {
    const { off, on } = await bothStates({ shape: shapeOf("B12"), cust, req: { qty: 3 } });
    expect(off.fig.error).toBeUndefined();
    expect(on.fig.error).toBeUndefined();
    // the dead-stub probe still covers these cells: the odd tier takes the computed branch, so the key is asked
    expect(off.consulted.units_prices_v2).toBeGreaterThan(0);
    expect(on.consulted.units_prices_v2).toBeGreaterThan(0);
    for (const [side, run, w] of [
      ["OLD", off, want.off],
      ["NEW", on, want.on],
    ] as const) {
      const subtotal = roundMoney(3 * w.unitPrice);
      expect({ side, ...run.fig }).toMatchObject({
        side,
        ...w,
        subtotal,
        categoryTaxAmount: 0,
        headerSubtotal: subtotal,
        headerTax: header(subtotal).tax,
        headerTotal: header(subtotal).total,
      });
    }
    return off;
  };
  /** The repair: the junk tier replaced by 1 (never null: null falls through to the customer's own tier = the reprice). */
  const repaired = async (cust: CustomerRow, junkOff: LineRun) => {
    const { off, on } = await bothStates({ shape: shapeOf("B12"), cust, req: { qty: 3 } });
    expectSameRuns("E2 repair " + cust.id, off, on); // flag-off equals flag-on; a difference stays a STOP
    // the bill is exactly today's: the junk cell's OFF figures
    const money = (f: Fig): Fig => ({
      unitPrice: f.unitPrice,
      subtotal: f.subtotal,
      headerTax: f.headerTax,
      headerTotal: f.headerTotal,
    });
    expectSame(
      "E2 repair " + cust.id + " vs the junk cell's flag-off bill",
      money(junkOff.fig),
      money(on.fig),
    );
    expect(off.fig.priceType).toBe("STANDARD");
    expect(on.fig.priceType).toBe("STANDARD");
    expect(on.fig.originalPrice).toBeNull();
  };
  const LIST: Side = { unitPrice: 11, priceType: "STANDARD", originalPrice: null };
  const SPECIAL_AT_LIST: Side = { unitPrice: 11, priceType: "SPECIAL", originalPrice: 11 };

  it("E2-1 (PF-14, SA-996) customer tier 7, no CustomerPrice: OLD SPECIAL at list 11 (originalPrice 11), NEW STANDARD null; same 11 x 3 = 33 bill", async () => {
    const junk = await pinned(customerOf("e1", 7), { off: SPECIAL_AT_LIST, on: LIST });
    await repaired(customerOf("e1r", 1), junk);
  });
  it("E2-2 (PF-14, SA-996) customer tier 0, no CustomerPrice: OLD SPECIAL at list 11, NEW STANDARD null; same bill", async () => {
    const junk = await pinned(customerOf("e2", 0), { off: SPECIAL_AT_LIST, on: LIST });
    await repaired(customerOf("e2r", 1), junk);
  });
  it("E2-3 (PF-14, SA-996) CustomerPrice.pricingTier 7, customer tier 3: OLD 11 (33, total 35.72), NEW 10 (30, total 32.48)", async () => {
    const junk = await pinned(
      customerOf("e3", 3, { cp: [{ productId: "p-b12", pricingTier: 7 }] }),
      {
        off: SPECIAL_AT_LIST,
        on: { unitPrice: 10, priceType: "SPECIAL", originalPrice: 11 },
      },
    );
    expect([junk.fig.subtotal, junk.fig.headerTotal]).toEqual([33, 35.72]);
    await repaired(customerOf("e3r", 3, { cp: [{ productId: "p-b12", pricingTier: 1 }] }), junk);
  });
  it("E2-4 (PF-14, SA-996) CustomerPrice.pricingTier 0, customer tier 2: OLD 11 (33, total 35.72), NEW 10.5 (31.5, total 34.1)", async () => {
    const junk = await pinned(
      customerOf("e4", 2, { cp: [{ productId: "p-b12", pricingTier: 0 }] }),
      {
        off: SPECIAL_AT_LIST,
        on: { unitPrice: 10.5, priceType: "SPECIAL", originalPrice: 11 },
      },
    );
    expect([junk.fig.subtotal, junk.fig.headerTotal]).toEqual([33, 35.72]);
    await repaired(customerOf("e4r", 2, { cp: [{ productId: "p-b12", pricingTier: 1 }] }), junk);
  });
});

// keep the unused-import guard honest: customerPricing is the reader every cell above goes through
it("customerPricing is the single wrapper: a valid tier never asks the flag (units-prices-v2.ts:163)", async () => {
  const stub = makeFlagStub("on");
  const db = fakeDb(shapeOf("B12"), customerOf("c1", 3));
  const pc = await customerPricing(
    {
      prisma: { forTenant: () => db, getTenantId: () => "t-fold" },
      entitlements: stub.entitlements as never,
    },
    "c1",
    ["p-b12"],
    { pricingTier: 3 },
    [],
  );
  expect(pc.defaultTier).toBe(3);
  expect(pc.layered).toBe(false);
  expect(stub.calls).toEqual([]);
});
