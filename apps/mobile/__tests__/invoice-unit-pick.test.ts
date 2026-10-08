import type { ProductUnitLevel } from "@routeflow/types";
import { buildLine, computeLineSubtotal, roundMoney, type LadderProduct } from "@routeflow/pricing";
import { buildUnitOptions, unitPriceBase, type UnitOption } from "../lib/unit-options";
import { computeInvoiceTotals } from "../lib/invoice-totals";
import { predictSaleInvoiceTotals, saleModeGate } from "../lib/sale-mode";
import {
  isPendingDefaultUnit,
  refusesLineEdit,
  resolvePendingDefaultUnits,
  startLineOnDefault,
} from "../lib/default-unit-line";
import {
  anyLineLoading,
  applyAddToItems,
  editItemLine,
  settleBeforeConfirm,
  type Items,
} from "../lib/pending-unit-adapter";
import { setLineQty, setLineUnits, stepLineQty } from "../lib/sale-line";
import { scanAcceptOpts } from "../lib/scan-ladder";
import { needsUnitLabelConfirm } from "../lib/scan-unit-confirm";
import {
  UNIT_NOT_OFFERED_MESSAGE,
  chooseInvoiceUnit,
  dropStaleUnitLines,
  invoiceItemDto,
  invoiceLinePrice,
  invoiceTotalsLine,
  normalizeInvoiceUnitLines,
  pickerLineOf,
  saleItemDto,
  unitNotOfferedCode,
  type InvoiceLineState,
} from "../lib/invoice-unit-pick";

jest.mock("../lib/toast", () => ({ showToast: jest.fn() }));

/**
 * VU-4b: the staff unit picker on the mobile New-invoice screen. Fixture (brief): a Box of 24 at
 * $48.00 with a ladder level Case = 12 pcs at $24.00. Every expected money value is computed with
 * @routeflow/pricing helpers; the brief's literal figures (102.00, 120.00, 6.67 ...) are asserted
 * alongside so the helper and the stated number must both hold.
 */

const level = (
  over: Partial<ProductUnitLevel> & Pick<ProductUnitLevel, "label" | "factorToBase">,
) =>
  ({
    id: over.label,
    price: null,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
    ...over,
  }) as ProductUnitLevel;

const PRODUCT: LadderProduct = {
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "48.00",
  priceTier3: "40.00",
};
const CASE = level({ label: "Case", factorToBase: 12, price: "24.00", priceTier3: "21.00" });
const PALLET = level({ label: "Pallet", factorToBase: 288 });

const optionsFor = (
  units: ProductUnitLevel[] = [CASE],
  tier = 1,
  product: LadderProduct = PRODUCT,
) => buildUnitOptions(product, units, tier);
const pick = (opts: UnitOption[], value: string) => opts.find((o) => o.value === value)!;
const totalOf = (
  line: InvoiceLineState,
  upb: number | null,
  catalog: number,
  rate = 0,
  extra: { discount?: number } = {},
) =>
  computeInvoiceTotals({
    lines: [invoiceTotalsLine({ ...line, ...extra }, upb, catalog, rate)],
  });

const BOX_LINE: InvoiceLineState = { qty: 24, boxes: 1, pieces: 0, sellBy: "case" };

describe("M: money", () => {
  it("M1 a 2-box + 3-piece boxed line is prorated (102.00), never 51 x the box price", () => {
    const line: InvoiceLineState = { qty: 51, boxes: 2, pieces: 3 };
    const expected = computeLineSubtotal({
      unitPrice: 48,
      qty: 51,
      boxes: 2,
      pieces: 3,
      unitsPerBox: 24,
    });
    expect(expected).toBe(102);
    expect(totalOf(line, 24, 48).total).toBe(expected);
    expect(totalOf(line, 24, 48).total).not.toBe(51 * 48);
    const dto = invoiceItemDto(line, { id: "p1", description: "Soda" }, 48, 24, 0);
    expect(dto).toMatchObject({ qty: 51, boxes: 2, pieces: 3, unitPrice: 48, productId: "p1" });
    expect(dto).not.toHaveProperty("unitLabel");
  });

  it("M2 Case x5 = 120.00 and the DTO is a unit line (no boxes/pieces)", () => {
    const opts = optionsFor();
    const line = { ...chooseInvoiceUnit(BOX_LINE, pick(opts, "Case"), 24), qty: 5 };
    const expected = computeLineSubtotal({ unitPrice: 24, qty: 5 });
    expect(expected).toBe(120);
    expect(totalOf(line, 24, 48).total).toBe(expected);
    const dto = invoiceItemDto(line, { id: "p1", description: "Soda" }, 48, 24, 0);
    expect(dto).toEqual({
      description: "Soda",
      productId: "p1",
      qty: 5,
      unitPrice: 24,
      unitLabel: "Case",
      taxRate: 0,
    });
    expect(dto).not.toHaveProperty("boxes");
    expect(dto).not.toHaveProperty("pieces");
  });

  it("M3 a Piece-as-pack line on a 3-pack at $10 prorates once: 3.33, 6.67 (never 6.66), 1 box = 10.00", () => {
    const three: LadderProduct = { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" };
    const opts = buildUnitOptions(three, [level({ label: "Case", factorToBase: 6 })], 1);
    const piece = pick(opts, "Piece");
    const start = chooseInvoiceUnit({ qty: 3, boxes: 1, pieces: 0 }, piece, 3);
    const at = (n: number) => setLineUnits(start, n, 3)!;
    const sub = (n: number) => totalOf(at(n), 3, 10).total;
    expect(sub(1)).toBe(
      computeLineSubtotal({ unitPrice: 10, qty: 1, boxes: 0, pieces: 1, unitsPerBox: 3 }),
    );
    expect(sub(1)).toBe(3.33);
    expect(sub(2)).toBe(6.67);
    expect(sub(2)).not.toBe(6.66);
    expect(sub(3)).toBe(10);
    expect(at(3)).toMatchObject({ boxes: 1, pieces: 0, qty: 3 });
    // 24-pack at $48 (2.00 a piece)
    const start24 = chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Piece"), 24);
    const at24 = (n: number) => setLineUnits(start24, n, 24)!;
    expect(totalOf(at24(5), 24, 48).total).toBe(10);
    expect(totalOf(at24(23), 24, 48).total).toBe(46);
  });

  it("M3b a level line total equals the server's buildLine unit-axis subtotal (Case x3, Pallet)", () => {
    const opts = optionsFor([CASE, PALLET]);
    for (const [label, factor, count, price] of [
      ["Case", 12, 3, 24],
      ["Pallet", 288, 2, 576],
    ] as const) {
      const line = { ...chooseInvoiceUnit(BOX_LINE, pick(opts, label), 24), qty: count };
      const server = buildLine({
        axis: { kind: "unit", label, count, factorToBase: factor },
        unitPrice: price,
      }).subtotal;
      expect(invoiceLinePrice(line, 48)).toBe(price);
      expect(totalOf(line, 24, 48).subtotal).toBe(server);
    }
  });

  it("M4 Case x3 = 72.00; a 5.00 line discount = 67.00; tax rides the net", () => {
    const line = { ...chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Case"), 24), qty: 3 };
    expect(totalOf(line, 24, 48).total).toBe(computeLineSubtotal({ unitPrice: 24, qty: 3 }));
    expect(totalOf(line, 24, 48).total).toBe(72);
    const net = totalOf(line, 24, 48, 0, { discount: 5 });
    expect(net.subtotal).toBe(67);
    const taxed = totalOf({ ...line, taxable: true }, 24, 48, 0.1, { discount: 5 });
    expect(taxed.taxTotal).toBe(roundMoney(67 * 0.1));
    expect(taxed.total).toBe(roundMoney(67 + roundMoney(67 * 0.1)));
  });

  it("M5 a half-cent figure rounds once (same as the server's unit line)", () => {
    const line: InvoiceLineState = {
      ...chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Case"), 24),
      qty: 3,
      unitPrice: 0.335,
    };
    const once = roundMoney(3 * 0.335);
    expect(totalOf(line, 24, 48).subtotal).toBe(once);
    expect(totalOf(line, 24, 48).subtotal).toBe(
      buildLine({
        axis: { kind: "unit", label: "Case", count: 3, factorToBase: 12 },
        unitPrice: 0.335,
      }).subtotal,
    );
  });

  it("M6 a non-boxed (upb 1) product stays a plain qty x price line with no split", () => {
    const single: LadderProduct = { unit: "Each", unitsPerBox: 1, pricePerUnit: "3.50" };
    const opts = buildUnitOptions(single, [level({ label: "Case", factorToBase: 6 })], 1);
    const line = chooseInvoiceUnit({ qty: 4 }, opts[0]!, 1);
    expect(line).toMatchObject({ qty: 4 }); // already on the pack: the count is kept
    expect(line.boxes).toBeUndefined();
    expect(line.pieces).toBeUndefined();
    const four = { ...line, qty: 4 };
    expect(totalOf(four, 1, 3.5).total).toBe(14);
    const dto = invoiceItemDto(four, { id: "p2", description: "Gum" }, 3.5, 1, 0);
    expect(dto).not.toHaveProperty("boxes");
    expect(dto).not.toHaveProperty("unitLabel");
    // a non-boxed pack already IS one piece: the ladder offers no separate Piece row
    expect(opts.some((o) => o.value === "Piece")).toBe(false);
    // and a level on it is a unit line like any other
    const lvl = chooseInvoiceUnit({ qty: 4 }, pick(opts, "Case"), 1);
    expect(lvl).toMatchObject({ unitLabel: "Case", qty: 1, unitFactor: 6 });
  });

  it("M7 Box -> Case -> Box round-trips to one clean box", () => {
    const opts = optionsFor();
    const toCase = chooseInvoiceUnit(BOX_LINE, pick(opts, "Case"), 24);
    expect(toCase).toMatchObject({ unitLabel: "Case", qty: 1, unitBasePrice: 24, unitFactor: 12 });
    const back = chooseInvoiceUnit(toCase, pick(opts, ""), 24);
    expect(back).toMatchObject({ qty: 24, boxes: 1, pieces: 0, sellBy: "case" });
    expect(back.unitLabel).toBeUndefined();
    expect(back.unitBasePrice).toBeUndefined();
    expect(back.unitFactor).toBeUndefined();
    expect(back.unitPrice).toBeUndefined();
    expect(totalOf(back, 24, 48).total).toBe(48);
  });
});

describe("U: picker behaviour", () => {
  it("U1 picking a level stores the tier price as the BASE, never as a typed price", () => {
    const t3 = optionsFor([CASE], 3);
    expect(pick(t3, "Case").price).toBe(21);
    const line = chooseInvoiceUnit(
      { qty: 2, boxes: 2, pieces: 0, unitPrice: 55 },
      pick(t3, "Case"),
      24,
    );
    expect(line.unitLabel).toBe("Case");
    expect(line.unitBasePrice).toBe(21);
    expect(line.unitFactor).toBe(12);
    expect(line.unitPrice).toBeUndefined();
    expect(line.priceSource).toBeUndefined();
    expect(line.qty).toBe(1);
    expect(line.boxes).toBeUndefined();
    expect(invoiceLinePrice(line, 40)).toBe(21);
    expect(unitPriceBase(line, 40)).toBe(21);
  });

  it("U2 a typed unit price survives a tier change that re-applies the same unit", () => {
    const first = chooseInvoiceUnit(BOX_LINE, pick(optionsFor([CASE], 1), "Case"), 24);
    const typed: InvoiceLineState = { ...first, unitPrice: 22.5, priceSource: "operator" };
    const again = chooseInvoiceUnit(typed, pick(optionsFor([CASE], 3), "Case"), 24);
    expect(again.unitPrice).toBe(22.5);
    expect(again.unitBasePrice).toBe(21);
    expect(invoiceLinePrice(again, 40)).toBe(22.5);
  });

  it("U3 a staff '+' tap starts on the flagged default unit; non-staff and flag-off stay on the pack", () => {
    const units = [{ ...CASE, isDefaultSelling: true }];
    const staff = applyAddToItems(
      {},
      {
        id: "p1",
        level: "BOX",
        dflt: true,
        viaRow: true,
        role: "OPERATOR",
        upb: 24,
      },
    );
    expect(isPendingDefaultUnit(staff.p1)).toBe(true);
    const started = startLineOnDefault(staff.p1!, PRODUCT, units, 1);
    expect(started).toMatchObject({ unitLabel: "Case", qty: 1, unitBasePrice: 24 });
    expect(isPendingDefaultUnit(started)).toBe(false);
    expect(totalOf(started, 24, 48).total).toBe(24);

    const driver = applyAddToItems(
      {},
      {
        id: "p1",
        level: "BOX",
        dflt: true,
        viaRow: true,
        role: "DRIVER",
        upb: 24,
      },
    );
    expect(isPendingDefaultUnit(driver.p1)).toBe(false);
    expect(driver.p1).toMatchObject({ boxes: 1, qty: 24 });

    return resolvePendingDefaultUnits(staff as Items, {
      isStaff: true,
      unitsEnabled: false,
      unitsKnown: true,
      getUnits: async () => units,
      productFor: () => PRODUCT,
      tierFor: () => 1,
    }).then(({ items, blocked }) => {
      expect(blocked).toEqual([]);
      expect(items.p1!.unitLabel).toBeUndefined();
      expect(items.p1).toMatchObject({ boxes: 1, qty: 24 });
    });
  });

  it("U4 a distinct box code adds one Box; a distinct piece code adds one loose piece; only a shared code starts on the default", () => {
    const base = { unitsPerBox: 24, sku: "S", unitSku: "U1", barcode: "B1" };
    const box = { ...base, scanMatch: { code: "B1", levels: ["BOX" as const] } };
    const piece = { ...base, scanMatch: { code: "U1", levels: ["UNIT" as const] } };
    const shared = {
      ...base,
      scanMatch: { code: "S1", levels: ["BOX" as const, "UNIT" as const] },
    };
    expect(scanAcceptOpts("B1", box).startOnDefault).toBeUndefined();
    expect(scanAcceptOpts("U1", piece).startOnDefault).toBeUndefined();
    expect(scanAcceptOpts("S1", shared).startOnDefault).toBe(true);
    const asBox = applyAddToItems(
      {},
      { id: "p1", level: "BOX", role: "OPERATOR", upb: 24, code: "B1" },
    );
    expect(asBox.p1).toMatchObject({ boxes: 1, pieces: 0, qty: 24 });
    const asPiece = applyAddToItems(
      {},
      { id: "p1", level: "UNIT", role: "OPERATOR", upb: 24, code: "U1" },
    );
    expect(asPiece.p1).toMatchObject({ boxes: 0, pieces: 1, qty: 1 });
    expect(totalOf(asPiece.p1!, 24, 48).total).toBe(2);
    expect(needsUnitLabelConfirm("UNIT", { unitsPerBox: 24 }, "Case")).toBe(true);
    expect(needsUnitLabelConfirm("UNIT", { unitsPerBox: 24 }, undefined)).toBe(false);
  });

  it("U5 an explicit Box choice sticks: the default-start flag is consumed", () => {
    const units = [{ ...CASE, isDefaultSelling: true }];
    const pending = applyAddToItems(
      {},
      {
        id: "p1",
        level: "BOX",
        dflt: true,
        viaRow: true,
        role: "OPERATOR",
        upb: 24,
      },
    ).p1!;
    const chosen = chooseInvoiceUnit(pending, pick(optionsFor(units), ""), 24);
    expect(isPendingDefaultUnit(chosen)).toBe(false);
    expect(chosen.startOnDefaultUnit).toBeUndefined();
    expect(chosen.pendingTaps).toBeUndefined();
    expect(chosen.pendingCode).toBeUndefined();
    expect(startLineOnDefault(chosen, PRODUCT, units, 1)).toBe(chosen);
    expect(chosen).toMatchObject({ boxes: 1, pieces: 0, qty: 24, sellBy: "case" });
  });

  it("U6 a pending line locks qty/price edits, Create waits while loading, and a blocked ladder sends nothing", async () => {
    const items = applyAddToItems(
      {},
      {
        id: "p1",
        level: "BOX",
        dflt: true,
        viaRow: true,
        role: "OPERATOR",
        upb: 24,
      },
    );
    expect(refusesLineEdit(items.p1, "qty")).toBe(true);
    expect(editItemLine(items, "p1", "qty", (prev) => setLineQty(prev, 9))).toBe(items);
    expect(anyLineLoading(items, () => "loading")).toBe(true);
    expect(anyLineLoading(items, () => "failed")).toBe(false);
    const settled = await settleBeforeConfirm(items, async (cur) => ({
      items: cur,
      blocked: ["p1"],
    }));
    expect(settled).toEqual({ kind: "blocked" });
  });

  it("U7 Piece-as-pack: the picker sees a 'Piece' line, the line itself never stores unitLabel; 7 of a 6-pack = 1 box + 1", () => {
    const six: LadderProduct = { unit: "Pack", unitsPerBox: 6, pricePerUnit: "12.00" };
    const opts = buildUnitOptions(six, [level({ label: "Case", factorToBase: 12 })], 1);
    const line = chooseInvoiceUnit(
      { qty: 6, boxes: 1, pieces: 0, unitPrice: 11 },
      pick(opts, "Piece"),
      6,
    );
    expect(line.unitLabel).toBeUndefined();
    expect(line.unitBasePrice).toBeUndefined();
    // B1: leaving the box for Piece changes ONLY sellBy; the split and the Box price are kept
    expect(line).toMatchObject({ sellBy: "unit", boxes: 1, pieces: 0, qty: 6, unitPrice: 11 });
    expect(pickerLineOf("p1", line, 12)).toEqual({
      productId: "p1",
      unitPrice: 11,
      unitLabel: "Piece",
    });
    expect(setLineUnits(line, 7, 6)).toMatchObject({ boxes: 1, pieces: 1, qty: 7 });
    // Piece -> Box restores the split exactly
    const sevenPcs = setLineUnits(line, 7, 6)!;
    const backToBox = chooseInvoiceUnit(sevenPcs, pick(opts, ""), 6);
    expect(backToBox).toMatchObject({ sellBy: "case", boxes: 1, pieces: 1, qty: 7 });
    // a pack line and a level line read straight from the line
    expect(pickerLineOf("p1", BOX_LINE, 48)).toEqual({
      productId: "p1",
      unitPrice: 48,
      unitLabel: undefined,
    });
    const lvl = chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Case"), 24);
    expect(pickerLineOf("p1", lvl, 48)).toMatchObject({ unitLabel: "Case", unitPrice: 24 });
  });

  it("U8 removing one from a Case line steps the COUNT (3 -> 2), never folding it into pack boxes", () => {
    const lvl = { ...chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Case"), 24), qty: 3 };
    const items: Items = { p1: lvl };
    const next = editItemLine(items, "p1", "increment", (prev) => stepLineQty(prev, -1, true, 24));
    expect(next.p1).toMatchObject({ qty: 2, unitLabel: "Case" });
    expect(next.p1!.boxes).toBeUndefined();
    const gone = editItemLine({ p1: { ...lvl, qty: 1 } }, "p1", "increment", (prev) =>
      stepLineQty(prev, -1, true, 24),
    );
    expect(gone.p1).toBeUndefined();
  });
});

describe("S: payloads", () => {
  it("S1 a standalone level line ALWAYS sends the effective unit price, even untouched", () => {
    const lvl = chooseInvoiceUnit(BOX_LINE, pick(optionsFor([CASE], 3), "Case"), 24);
    expect(lvl.unitPrice).toBeUndefined();
    const dto = invoiceItemDto({ ...lvl, qty: 2 }, { id: "p1", description: "Soda" }, 40, 24, 0);
    expect(dto).toMatchObject({ qty: 2, unitPrice: 21, unitLabel: "Case" });
  });

  it("S2 a stale unit is dropped to one Box; UNIT_NOT_OFFERED is recognised, a generic 500 is not", () => {
    const lvl = {
      ...chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Case"), 24),
      qty: 4,
      unitPrice: 20,
    };
    const piece = chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Piece"), 24);
    const plain: InvoiceLineState = { qty: 3, boxes: 3, pieces: 0 };
    const still = { ...lvl, unitLabel: "Pallet", unitFactor: 288 }; // still offered
    const fixed = dropStaleUnitLines(
      { a: lvl, b: piece, c: plain, d: still },
      (_id, label) => label !== "Case",
      () => 24,
    );
    expect(fixed.d).toBe(still); // B2: only the refused label is reset, not every unit line
    expect(fixed.a).toMatchObject({ qty: 24, boxes: 1, pieces: 0, sellBy: "case" });
    expect(fixed.a!.unitLabel).toBeUndefined();
    expect(fixed.a!.unitPrice).toBeUndefined(); // a unit price is meaningless on a box
    expect(fixed.b).toBe(piece); // a Piece-as-pack line carries no unitLabel: not stale
    expect(fixed.c).toBe(plain);
    expect(unitNotOfferedCode({ response: { data: { code: "UNIT_NOT_OFFERED" } } })).toBe(true);
    expect(unitNotOfferedCode({ response: { status: 500, data: { message: "boom" } } })).toBe(
      false,
    );
    expect(unitNotOfferedCode(undefined)).toBe(false);
    expect(UNIT_NOT_OFFERED_MESSAGE).toBe(
      "That unit isn't offered for this product any more. Choose another unit, or ask an admin to add it back.",
    );
  });

  it("S3 a sale level line sends the unit only; a price only when typed off the unit base; a special needs a reason", () => {
    const t3 = optionsFor([CASE], 3);
    const lvl = chooseInvoiceUnit(BOX_LINE, pick(t3, "Case"), 24);
    const p = { id: "p1", unitsPerBox: 24 };
    const ctx = { catalogPrice: 40, listPrice: 48, isSpecial: false };
    const untouched = saleItemDto(lvl, p, ctx);
    expect(untouched).toEqual({ productId: "p1", qty: 1, unitLabel: "Case" });
    expect(untouched).not.toHaveProperty("unitPrice");
    expect(saleItemDto({ ...lvl, qty: 3 }, p, ctx)).toMatchObject({ qty: 3 });
    expect(saleItemDto({ ...lvl, unitPrice: 20 }, p, ctx)).toMatchObject({
      productId: "p1",
      unitLabel: "Case",
      unitPrice: 20,
    });
    // within half a cent of the unit base is not an override
    expect(saleItemDto({ ...lvl, unitPrice: 21.004 }, p, ctx)).not.toHaveProperty("unitPrice");
    const special = { ...ctx, isSpecial: true };
    expect(saleItemDto({ ...lvl, unitPrice: 20 }, p, special)).toEqual({ refused: true });
    expect(
      saleItemDto({ ...lvl, unitPrice: 20, overrideReason: " damaged " }, p, special),
    ).toMatchObject({
      unitPrice: 20,
      overrideReason: "damaged",
    });
    expect(saleItemDto({ ...lvl, note: " fragile " }, p, ctx)).toMatchObject({
      notes: "fragile",
    });
  });

  it("S3b a sale pack line keeps today's payload: effective price, boxes/pieces, no unitLabel", () => {
    const p = { id: "p1", unitsPerBox: 24 };
    const ctx = { catalogPrice: 48, listPrice: 48, isSpecial: false };
    const dto = saleItemDto({ qty: 51, boxes: 2, pieces: 3 }, p, ctx);
    expect(dto).toEqual({ productId: "p1", qty: 51, unitPrice: 48, boxes: 2, pieces: 3 });
    const piece = setLineUnits(
      chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Piece"), 24),
      1,
      24,
    )!;
    expect(saleItemDto(piece, p, ctx)).toEqual({
      productId: "p1",
      qty: 1,
      unitPrice: 48,
      boxes: 0,
      pieces: 1,
    });
  });
});

describe("G1: the van-sale gate with a unit line in the cart", () => {
  it("stays eligible and the predicted sale total equals the previewed invoice total", () => {
    const lvl = { ...chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Case"), 24), qty: 5 };
    const lines = [
      invoiceTotalsLine(lvl, 24, 48, 0),
      invoiceTotalsLine({ qty: 51, boxes: 2, pieces: 3 }, 24, 48, 0),
    ];
    const gate = saleModeGate({
      lines,
      hasUnlistedInvalid: false,
      invDiscount: 0,
      shippingFee: 0,
      isTaxExempt: false,
      taxRateFraction: 0,
      touched: { dueDate: false, terms: false, reference: false, subject: false },
      sendNowOn: false,
      deliveredNow: true,
      hasSeparateInvoiceCategoryLine: false,
    });
    expect(gate).toEqual({ eligible: true });
    const predicted = predictSaleInvoiceTotals({
      lines,
      shippingFee: 0,
      isTaxExempt: false,
      taxRateFraction: 0,
    });
    expect(predicted.total).toBe(computeInvoiceTotals({ lines }).total);
    expect(predicted.total).toBe(roundMoney(120 + 102));
  });
});

describe("N: a factor-1 Piece default never becomes a unit line on a boxed product", () => {
  const PIECE_DEFAULT = level({
    label: "Piece",
    factorToBase: 1,
    price: "2.10",
    isDefaultSelling: true,
  });
  const productFor = (id: string) => (id === "p1" ? { unitsPerBox: 24 } : { unitsPerBox: 1 });

  it("the resolver's output is rewritten to the piece-as-pack line; pack proration bills it; no unitLabel on either DTO", () => {
    const pending = applyAddToItems(
      {},
      {
        id: "p1",
        level: "BOX",
        dflt: true,
        viaRow: true,
        role: "OPERATOR",
        upb: 24,
      },
    ).p1!;
    const resolved = startLineOnDefault(pending, PRODUCT, [PIECE_DEFAULT], 1);
    expect(resolved).toMatchObject({ unitLabel: "Piece", unitFactor: 1 }); // the shared resolver's shape
    const fixed = normalizeInvoiceUnitLines({ p1: resolved }, productFor).p1!;
    expect(fixed).toMatchObject({ sellBy: "unit", boxes: 0, pieces: 1, qty: 1 });
    expect(fixed.unitLabel).toBeUndefined();
    expect(fixed.unitBasePrice).toBeUndefined();
    expect(fixed.unitFactor).toBeUndefined();
    expect(fixed.unitPrice).toBeUndefined();
    const expected = computeLineSubtotal({
      unitPrice: 48,
      qty: 1,
      boxes: 0,
      pieces: 1,
      unitsPerBox: 24,
    });
    expect(expected).toBe(2);
    expect(totalOf(fixed, 24, 48).total).toBe(expected);
    expect(invoiceItemDto(fixed, { id: "p1", description: "Soda" }, 48, 24, 0)).not.toHaveProperty(
      "unitLabel",
    );
    const sale = saleItemDto(
      fixed,
      { id: "p1", unitsPerBox: 24 },
      {
        catalogPrice: 48,
        listPrice: 48,
        isSpecial: false,
      },
    );
    expect(sale).not.toHaveProperty("unitLabel");
    expect(sale).toMatchObject({ boxes: 0, pieces: 1, unitPrice: 48 });
  });

  it("keeps the tap count (3 taps = 3 pieces) and rolls a full box over", () => {
    const three = { unitLabel: "Piece", unitFactor: 1, unitBasePrice: 2.1, qty: 3 };
    expect(normalizeInvoiceUnitLines({ p1: three }, productFor).p1).toMatchObject({
      pieces: 3,
      qty: 3,
      boxes: 0,
    });
    const full = { ...three, qty: 24 };
    expect(normalizeInvoiceUnitLines({ p1: full }, productFor).p1).toMatchObject({
      boxes: 1,
      pieces: 0,
      qty: 24,
    });
  });

  it("leaves everything else alone and returns the SAME object when nothing changes", () => {
    const lvl = chooseInvoiceUnit(BOX_LINE, pick(optionsFor(), "Case"), 24);
    const items = {
      p1: lvl, // a real level (factor 12)
      p2: { unitLabel: "Piece", unitFactor: 1, unitBasePrice: 2, qty: 4 }, // non-boxed: a Piece IS the unit
      p3: BOX_LINE,
    };
    expect(
      normalizeInvoiceUnitLines(items, (id) =>
        id === "p2" ? { unitsPerBox: 1 } : { unitsPerBox: 24 },
      ),
    ).toBe(items);
    expect(normalizeInvoiceUnitLines(items, () => undefined)).toBe(items); // unknown product: untouched
  });
});

describe("B1: Box / Piece never throw the quantity away", () => {
  const OPTS = optionsFor();
  const five3: InvoiceLineState = { qty: 123, boxes: 5, pieces: 3, sellBy: "case", unitPrice: 50 };

  it("re-picking the selected row is a no-op (same object)", () => {
    expect(chooseInvoiceUnit(five3, pick(OPTS, ""), 24)).toBe(five3);
    const asPiece = chooseInvoiceUnit(five3, pick(OPTS, "Piece"), 24);
    expect(chooseInvoiceUnit(asPiece, pick(OPTS, "Piece"), 24)).toBe(asPiece);
  });

  it("Box <-> Piece changes only sellBy: 5 boxes + 3 pcs survive both ways, with the Box price", () => {
    const asPiece = chooseInvoiceUnit(five3, pick(OPTS, "Piece"), 24);
    expect(asPiece).toMatchObject({ sellBy: "unit", boxes: 5, pieces: 3, qty: 123, unitPrice: 50 });
    expect(asPiece.unitLabel).toBeUndefined();
    const back = chooseInvoiceUnit(asPiece, pick(OPTS, ""), 24);
    expect(back).toMatchObject({ sellBy: "case", boxes: 5, pieces: 3, qty: 123, unitPrice: 50 });
    expect(totalOf(back, 24, 48).total).toBe(totalOf(five3, 24, 48).total);
  });

  it("only LEAVING a level resets the count", () => {
    const lvl = { ...chooseInvoiceUnit(five3, pick(OPTS, "Case"), 24), qty: 4 };
    expect(chooseInvoiceUnit(lvl, pick(OPTS, ""), 24)).toMatchObject({
      boxes: 1,
      pieces: 0,
      qty: 24,
    });
    expect(chooseInvoiceUnit(lvl, pick(OPTS, "Piece"), 24)).toMatchObject({
      sellBy: "unit",
      boxes: 0,
      pieces: 1,
      qty: 1,
    });
  });

  it("a pending default-start line still has its flag consumed by a Box re-pick", () => {
    const pending: InvoiceLineState = { ...BOX_LINE, startOnDefaultUnit: 24, pendingTaps: 1 };
    const chosen = chooseInvoiceUnit(pending, pick(OPTS, ""), 24);
    expect(chosen).not.toBe(pending);
    expect(chosen.startOnDefaultUnit).toBeUndefined();
    expect(chosen).toMatchObject({ boxes: 1, qty: 24 });
  });
});

describe("nits: the picker sees the chosen Piece row; a unit sale carries the unit's own list price", () => {
  it("pickerLineOf reports the Piece option's own value, not a hard-coded label", () => {
    const each = level({ label: "Each", factorToBase: 1 });
    const opts = buildUnitOptions(PRODUCT, [CASE, each], 1);
    const piece = opts.find((o) => o.kind === "piece")!;
    expect(piece.value).toBe("Each");
    const line = chooseInvoiceUnit(BOX_LINE, piece, 24);
    expect(pickerLineOf("p1", line, 48).unitLabel).toBe("Each");
    expect(line.unitLabel).toBeUndefined();
    expect(pickerLineOf("p1", chooseInvoiceUnit(line, opts[0]!, 24), 48).unitLabel).toBeUndefined();
  });

  it("a level pick remembers the unit's list price for the sale override decision", () => {
    const t3 = optionsFor([CASE], 3);
    const lvl = chooseInvoiceUnit(BOX_LINE, pick(t3, "Case"), 24);
    expect(lvl.unitListPrice).toBe(pick(t3, "Case").listPrice);
    expect(lvl.unitListPrice).not.toBe(48);
  });
});
