/**
 * H3b — a typed price on a manual-invoice line is judged by THE staff-override rule against the customer's
 * TIER price (POST /invoices create and PATCH /invoices/:id edit), so it stores what POST /orders/sell stores
 * for the same input: priceType, originalPrice, overrideReason, overriddenBy and the line total.
 *
 * Pure (no DB, no Nest): the builders are called directly with an override ctx. The unit-line parity against
 * the ORDER unit builder lives in invoice-override-parity.db.spec.ts (it needs the order unit path of #3432).
 *
 *  B1-B8  create builder, PACK line: manual override with reason, tier price, missing reason (400), below
 *         list, tier 1, no ctx (internal callers unchanged), unlisted line, formula-led reason
 *  B9     parity matrix: every typed price x reason x tier stores what the order create() decides
 *  U1-U3  create builder, UNIT line (Case): the same three outcomes off the ladder's tier unit price
 *  E1-E7  edit plan: an unchanged stored price keeps its type/reason/author; a changed one re-decides
 */
import { BadRequestException } from "@nestjs/common";
import { computeLineSubtotal, type LadderUnit } from "@routeflow/pricing";
import { decideTierOverride, specialPriceReasonRequired } from "../orders/staff-override";
import { resolveLineUnits } from "../products/line-units";
import { buildEditedLines, matchEditLines, type StoredEditRow } from "./invoice-edit-plan";
import type { LineOverrideCtx } from "./invoice-line-override";
import { buildManualInvoiceLines } from "./manual-invoice-lines";

// A pack product: list $24, tier-3 $20 (a loose pack, no box split).
const PACK = {
  id: "pk",
  name: "Widget",
  unit: "Each",
  unitsPerBox: null as number | null,
  pricePerUnit: "24.00",
  priceTier2: null,
  priceTier3: "20.00",
  priceTier4: null,
  priceTier5: null,
  trackedCategoryId: null as string | null,
  trackedSubcategoryId: null as string | null,
};
// A boxed product with a Case level: list $24 / tier-3 $20 per Case (factor 288 of a 24-piece box).
const BOXED = {
  ...PACK,
  id: "bx",
  name: "Soda",
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "1.00",
};
const CASE: LadderUnit = {
  label: "Case",
  factorToBase: 288,
  price: "24.00",
  priceTier2: null,
  priceTier3: "20.00",
  priceTier4: null,
  priceTier5: null,
} as unknown as LadderUnit;

const ctxFor = (tier: number): LineOverrideCtx => ({
  actorId: "user-1",
  tierOf: () => tier,
  ladders: new Map([["bx", [CASE]]]),
});
const clamp = (free: number | undefined) => free ?? 0;

function build(items: unknown[], override?: LineOverrideCtx) {
  const products = [PACK, BOXED];
  const productMap = new Map(products.map((p) => [p.id, p]));
  const resolved = (items as Array<{ productId?: string; unitLabel?: string }>).map((it) => {
    const p = productMap.get(it.productId ?? "");
    return resolveLineUnits(p ?? {}, override?.ladders.get(it.productId ?? "") ?? [], it as never);
  });
  return buildManualInvoiceLines(items as never, {
    productMap,
    categoryMap: new Map(),
    tenantId: "t-1",
    clampFreeUnits: clamp,
    resolved,
    override,
  });
}
const line = (over: Record<string, unknown> = {}) => ({
  description: "Widget",
  productId: "pk",
  qty: 3,
  unitPrice: 24,
  ...over,
});
const caseLine = (over: Record<string, unknown> = {}) =>
  line({ description: "Soda", productId: "bx", unitLabel: "Case", ...over });
const stampOf = (l: any) => ({
  priceType: l.priceType,
  originalPrice: l.originalPrice,
  overrideReason: l.overrideReason,
  overriddenBy: l.overriddenBy,
});

describe("H3b create builder — a typed PACK price is judged against the customer's tier price", () => {
  it("B1: tier 3 (list $24 / tier $20) x3, typed $24 with a reason is MANUAL: reason + user, original = list, $72", () => {
    const { itemsData, subtotal } = build(
      [line({ overrideReason: "  agreed at list  " })],
      ctxFor(3),
    );
    expect(stampOf(itemsData[0])).toEqual({
      priceType: "MANUAL",
      originalPrice: 24,
      overrideReason: "agreed at list",
      overriddenBy: "user-1",
    });
    expect(itemsData[0]).toMatchObject({ unitPrice: 24, subtotal: 72 });
    expect(subtotal).toBe(72);
  });

  it("B2: typed at the tier price (within half a cent) is SPECIAL with no reason and no stamp, $60", () => {
    for (const typed of [20, 20.004, 19.996]) {
      const { itemsData } = build([line({ unitPrice: typed })], ctxFor(3));
      expect(stampOf(itemsData[0])).toEqual({
        priceType: "SPECIAL",
        originalPrice: 24,
        overrideReason: null,
        overriddenBy: null,
      });
      expect(itemsData[0]).toMatchObject({ unitPrice: 20, subtotal: 60 }); // the clean tier price
    }
  });

  it("B3: typed off the special price with NO reason is the order path's own 400, nothing built", () => {
    let thrown: any;
    try {
      build([line()], ctxFor(3));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(thrown.message).toBe(specialPriceReasonRequired("Widget").message);
    // a blank reason is no reason
    expect(() => build([line({ overrideReason: "   " })], ctxFor(3))).toThrow(BadRequestException);
  });

  it("B4: typed below list with a reason is DISCOUNTED (original = list)", () => {
    const { itemsData } = build([line({ unitPrice: 15, overrideReason: "damaged" })], ctxFor(3));
    expect(stampOf(itemsData[0])).toEqual({
      priceType: "DISCOUNTED",
      originalPrice: 24,
      overrideReason: "damaged",
      overriddenBy: "user-1",
    });
  });

  it("B5: tier 1 (list is the tier price) needs no reason: off it is an override, on it is STANDARD", () => {
    const off = build([line({ unitPrice: 20 })], ctxFor(1)).itemsData[0];
    expect(stampOf(off)).toEqual({
      priceType: "DISCOUNTED",
      originalPrice: 24,
      overrideReason: null,
      overriddenBy: "user-1",
    });
    const on = build([line()], ctxFor(1)).itemsData[0];
    expect(stampOf(on)).toEqual({
      priceType: "STANDARD",
      originalPrice: null,
      overrideReason: null,
      overriddenBy: null,
    });
  });

  it("B6: no ctx (estimate conversion, recurring invoices) is byte-for-byte today: the sent price, no price columns", () => {
    const { itemsData } = build([line()]);
    expect(itemsData[0]).toMatchObject({ unitPrice: 24, subtotal: 72 });
    for (const k of ["priceType", "originalPrice", "overrideReason", "overriddenBy"]) {
      expect(itemsData[0]).not.toHaveProperty(k);
    }
  });

  it("B7: an unlisted charge (no product) is never judged", () => {
    const { itemsData } = build([{ description: "Delivery", qty: 1, unitPrice: 9.5 }], ctxFor(3));
    expect(itemsData[0]).toMatchObject({ unitPrice: 9.5, subtotal: 9.5 });
    expect(itemsData[0]).not.toHaveProperty("priceType");
  });

  it("B8: a formula-led reason is refused with the text-cell 400", () => {
    let thrown: any;
    try {
      build([line({ overrideReason: "=HYPERLINK(x)" })], ctxFor(3));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(thrown.getResponse()).toMatchObject({ field: "overrideReason" });
  });

  it("B9: parity — every typed price x reason x tier stores what the ORDER create() decides (or both refuse)", () => {
    for (const tier of [1, 2, 3]) {
      for (const typed of [0, 10, 19.996, 20, 20.004, 22, 23.99, 24, 24.01, 30]) {
        for (const reason of [undefined, "  why  "]) {
          let want: any;
          try {
            const d = decideTierOverride(PACK, tier, typed, reason);
            want = {
              priceType: d.priceType,
              originalPrice: d.originalPrice,
              unitPrice: d.unitPrice,
              overrideReason: d.overridden ? reason?.trim() || null : null,
              overriddenBy: d.overridden ? "user-1" : null,
            };
          } catch (e) {
            want = e;
          }
          const item = line({ unitPrice: typed, overrideReason: reason, qty: 3 });
          if (want instanceof Error) {
            expect(() => build([item], ctxFor(tier))).toThrow(want.message);
            continue;
          }
          const got = build([item], ctxFor(tier)).itemsData[0] as any;
          expect({ ...stampOf(got), unitPrice: got.unitPrice }).toEqual(want);
          expect(got.subtotal).toBe(
            computeLineSubtotal({ unitPrice: want.unitPrice, qty: 3, unitsPerBox: null }),
          );
        }
      }
    }
  });
});

describe("H3b create builder — a typed UNIT price is judged against the ladder's tier unit price", () => {
  it("U1: Case x3, list $24 / tier-3 $20, typed $24 with a reason is MANUAL, original = list, $72", () => {
    const { itemsData } = build([caseLine({ overrideReason: "agreed at list" })], ctxFor(3));
    expect(stampOf(itemsData[0])).toEqual({
      priceType: "MANUAL",
      originalPrice: 24,
      overrideReason: "agreed at list",
      overriddenBy: "user-1",
    });
    expect(itemsData[0]).toMatchObject({
      unitLabel: "Case",
      boxes: 3,
      unitPrice: 24,
      subtotal: 72,
    });
  });

  it("U2: typed at the tier unit price is SPECIAL, no stamp, $60 — the same stored price as untyped", () => {
    const { itemsData } = build([caseLine({ unitPrice: 20 })], ctxFor(3));
    expect(stampOf(itemsData[0])).toEqual({
      priceType: "SPECIAL",
      originalPrice: 24,
      overrideReason: null,
      overriddenBy: null,
    });
    expect(itemsData[0]).toMatchObject({ unitPrice: 20, subtotal: 60 });
  });

  it("U3: typed off the special unit price with NO reason is the same 400 as the pack line", () => {
    expect(() => build([caseLine()], ctxFor(3))).toThrow(
      specialPriceReasonRequired("Soda").message,
    );
  });

  it("U4: below the tier-1 unit price with a reason is DISCOUNTED", () => {
    const { itemsData } = build(
      [caseLine({ unitPrice: 18, overrideReason: "pallet deal" })],
      ctxFor(3),
    );
    expect(stampOf(itemsData[0])).toMatchObject({
      priceType: "DISCOUNTED",
      originalPrice: 24,
      overrideReason: "pallet deal",
    });
  });
});

// ── edit plan ────────────────────────────────────────────────────────────────

const row = (over: Record<string, unknown> = {}): StoredEditRow => ({
  id: "row-1",
  invoiceId: "inv-1",
  productId: "pk",
  description: "Widget",
  qty: 3,
  unitPrice: 24,
  discount: 0,
  taxRate: 0,
  subtotal: 72,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  promoFreeUnits: null,
  notes: null,
  orderItemId: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  categoryTaxAmount: 0,
  priceType: "MANUAL",
  originalPrice: 24,
  overrideReason: "stored reason",
  overriddenBy: "user-0",
  ...over,
});
const sent = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  productId: "pk",
  description: "Widget",
  qty: 3,
  unitPrice: 24,
  discount: 0,
  taxRate: 0,
  ...over,
});
function plan(items: any[], stored: StoredEditRow[], tier = 3, extraProducts: any[] = []) {
  const products = [PACK, BOXED, { ...PACK, id: "pk2", name: "Gadget" }, ...extraProducts];
  const resolved = items.map((it) =>
    it.unitLabel
      ? resolveLineUnits(BOXED, [CASE], it, stored.find((r) => r.id === it.id) as never)
      : undefined,
  );
  return buildEditedLines({
    items,
    stored,
    matches: matchEditLines(items, stored),
    productMap: new Map(products.map((p) => [p.id, p])),
    categoryMap: new Map(),
    clampFreeUnits: clamp,
    warn: jest.fn(),
    resolved,
    override: ctxFor(tier),
  } as never);
}

describe("H3b edit plan — an unchanged stored price is kept, a changed one is re-decided", () => {
  it("E1: qty changes, the price is re-sent: the stored MANUAL type, reason and author stay, no reason needed", () => {
    const [l] = plan([sent({ qty: 5 })], [row()]);
    expect(l.untouched).toBe(false);
    expect(stampOf(l.data)).toEqual({
      priceType: "MANUAL",
      originalPrice: 24,
      overrideReason: "stored reason",
      overriddenBy: "user-0",
    });
    expect(l.data.subtotal).toBe(120);
  });

  it("E2: a CHANGED price off the special price needs a reason (400), and with one is a fresh override by THIS user", () => {
    expect(() => plan([sent({ unitPrice: 22 })], [row()])).toThrow(
      specialPriceReasonRequired("Widget").message,
    );
    const [l] = plan([sent({ unitPrice: 22, overrideReason: "new deal" })], [row()]);
    expect(stampOf(l.data)).toEqual({
      priceType: "DISCOUNTED",
      originalPrice: 24,
      overrideReason: "new deal",
      overriddenBy: "user-1",
    });
  });

  it("E3: changed back to the tier price: SPECIAL, and the old reason/author are cleared", () => {
    const [l] = plan([sent({ unitPrice: 20 })], [row()]);
    expect(stampOf(l.data)).toEqual({
      priceType: "SPECIAL",
      originalPrice: 24,
      overrideReason: null,
      overriddenBy: null,
    });
    expect(l.data.unitPrice).toBe(20);
  });

  it("E4: a NEW line (no id) is decided like a create line", () => {
    const [, added] = plan(
      [
        sent(),
        { productId: "pk2", description: "Gadget", qty: 1, unitPrice: 24, overrideReason: "list" },
      ],
      [row()],
    );
    expect(added.rowId).toBeNull();
    expect(stampOf(added.data)).toMatchObject({ priceType: "MANUAL", overriddenBy: "user-1" });
  });

  it("E5: a row re-pointed at ANOTHER product is a new sale — the same number is decided afresh", () => {
    expect(() => plan([sent({ productId: "pk2", qty: 5 })], [row()])).toThrow(
      specialPriceReasonRequired("Gadget").message,
    );
  });

  it("E6: an untouched row is written back verbatim (its stored stamp rides in the row)", () => {
    const [l] = plan([sent()], [row()]);
    expect(l.untouched).toBe(true);
    expect(stampOf(l.data)).toMatchObject({
      overrideReason: "stored reason",
      overriddenBy: "user-0",
    });
  });

  it("E7: a stored Case row — qty changed, price re-sent keeps the stamp; a pack row re-sent as Case is decided afresh", () => {
    const caseRow = row({
      productId: "bx",
      description: "Soda",
      qty: 864,
      boxes: 3,
      pieces: 0,
      unitsPerBox: 288,
      unitLabel: "Case",
    });
    const [kept] = plan(
      [sent({ productId: "bx", description: "Soda", unitLabel: "Case", qty: 4 })],
      [caseRow],
    );
    expect(stampOf(kept.data)).toMatchObject({
      priceType: "MANUAL",
      overrideReason: "stored reason",
    });
    expect(kept.data).toMatchObject({ boxes: 4, unitLabel: "Case", subtotal: 96 });

    const packRow = row({ productId: "bx", description: "Soda" });
    expect(() =>
      plan([sent({ productId: "bx", description: "Soda", unitLabel: "Case" })], [packRow]),
    ).toThrow(specialPriceReasonRequired("Soda").message);
  });
});
