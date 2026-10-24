import { readFileSync } from "fs";
import { join } from "path";
import {
  computeLineSubtotal,
  effectiveQty,
  ladderOptionLineTotal,
  planBaseBilling,
  prorateLineSubtotal,
} from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import type { LineState, Product } from "../lib/cart-line-state";
import { computeOrderTotal } from "../lib/cart-order-total";
import { applyUnitOption, mergeResolvedDefaults } from "../lib/default-unit-line";
import {
  fromOrderDraftPayload,
  toOrderDraftPayload,
  type DraftBuilderState,
  type DraftCatalogLine,
} from "../lib/drafts-payload";
import {
  applyPieceEdit,
  applyUnitPick,
  deserializeEditItemsSnapshot,
  hydrateFromOrder,
  makeEditItemsSnapshot,
  resolveDraftKeyForPick,
  serializeEditItemsSnapshot,
  snapshotBaseline,
  stagedDiffItems,
  startsOnDefaultUnit,
  type DraftItem,
} from "../lib/edit-items-draft";
import { resolveResumeDerivedBase } from "../lib/order-draft-logic";
import {
  buildDeliveries,
  freeUnitSizeFor,
  isUnitAwareLine,
  reconciledTotal,
  shortPickLinesFromOrder,
} from "../lib/short-pick";
import { buildUnitOptions, unitPickerValue } from "../lib/unit-options";

/**
 * Units P0b / SA-728: the mobile `derivedBase` marker. A derived-Piece pick is a PACK-PIECES line (boxes/pieces, no
 * unitLabel); the marker is CLIENT-ONLY display state (the same field web uses, declared once as `DerivedBaseMarker`
 * in @routeflow/pricing). It is stripped from every API payload, persisted in drafts, part of the line's identity
 * (a merge never folds a marker line into a pack line), and a pack-pieces line WITHOUT it is shown as a PACK line,
 * never guessed into a Piece.
 */
const lvl = (label: string, factorToBase: number, price: string | null): ProductUnitLevel =>
  ({
    id: label,
    label,
    factorToBase,
    price,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
  }) as ProductUnitLevel;
const pack3 = { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" };
const derived = buildUnitOptions(pack3, [lvl("Case", 12, null)], 1);
const pieceOption = derived.find((o) => o.kind === "piece")!;
const packOption = derived.find((o) => o.value === "")!;

const draftItem = (over: Partial<DraftItem> = {}): DraftItem => ({
  productId: "p",
  qty: 2,
  boxes: 0,
  pieces: 2,
  boxSplit: true,
  unitsPerBox: 3,
  unitPrice: 10,
  catalogPrice: 10,
  name: "x",
  packLadder: pack3,
  derivedBase: "Piece",
  ...over,
});

describe("the marker never reaches an API request body", () => {
  it("edit-items: a NEW derived-Piece line goes out as boxes 0 / pieces N, with no marker key", () => {
    const out = stagedDiffItems(
      { draft: { "new:a": draftItem() }, unlisted: [], pendingDeletes: [] },
      [],
    );
    expect(out).toEqual([{ productId: "p", qty: 2, boxes: 0, pieces: 2 }]);
    expect(JSON.stringify(out)).not.toContain("derivedBase");
  });
  it("edit-items: an UPDATE of an existing line carries no marker either", () => {
    const out = stagedDiffItems(
      { draft: { L1: draftItem({ lineId: "L1" }) }, unlisted: [], pendingDeletes: [] },
      [{ id: "L1", productId: "p", qty: 3, unitPrice: 10 }],
    );
    expect(out).toEqual([{ id: "L1", action: "UPDATE", qty: 2, boxes: 0, pieces: 2 }]);
    expect(JSON.stringify(out)).not.toContain("derivedBase");
  });
  it("create-order: the cart's catalog payload builder names its keys and never spreads the line", () => {
    const src = readFileSync(join(__dirname, "../components/NewOrderScreen.tsx"), "utf8");
    const start = src.indexOf("const catalogPayload: CreateOrderItemInput[]");
    const end = src.indexOf("const unlistedPayload", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/derivedBase/);
    expect(block).not.toMatch(/\.\.\.line\b/);
  });
});

describe("the marker is persisted in drafts", () => {
  const catalogLine = (over: Partial<DraftCatalogLine> = {}): DraftCatalogLine => ({
    productId: "p",
    productName: "x",
    unit: "Pack",
    listPrice: 10,
    unitPrice: 10,
    priceType: "STANDARD",
    qty: 2,
    unitsPerBox: 3,
    boxes: 0,
    pieces: 2,
    ...over,
  });
  const state = (items: DraftCatalogLine[]): DraftBuilderState => ({
    customer: { id: "c", businessName: "c" },
    items,
    unlisted: [],
    floorAcked: [],
    orderNotes: "",
    orderUrgent: false,
    deliveryDate: "",
    orderDate: "",
    discountRaw: "",
    shippingFeeRaw: "",
    selectedCreditIds: [],
    fulfillPath: "ROUTE",
  });

  it("the cart draft payload carries the marker and a JSON round trip restores it", () => {
    const wire = JSON.parse(
      JSON.stringify(toOrderDraftPayload(state([catalogLine({ derivedBase: "Piece" })]))),
    );
    expect(wire.lineItems[0].derivedBase).toBe("Piece");
    const back = fromOrderDraftPayload(wire);
    expect(back.items[0]!.derivedBase).toBe("Piece");
    expect(back.items[0]!.extra).toBeUndefined();
  });
  it("a line with no marker parks with no marker key (a pack line stays a pack line)", () => {
    const wire = JSON.parse(JSON.stringify(toOrderDraftPayload(state([catalogLine()]))));
    expect("derivedBase" in wire.lineItems[0]).toBe(false);
    expect(fromOrderDraftPayload(wire).items[0]!.derivedBase).toBeUndefined();
  });
  it("resume keeps the marker only while the pack size is unchanged and the line is a plain pack line", () => {
    expect(resolveResumeDerivedBase({ derivedBase: "Piece", unitsPerBox: 3 }, 3)).toBe("Piece");
    expect(resolveResumeDerivedBase({ derivedBase: "Piece", unitsPerBox: 3 }, 6)).toBeUndefined();
    expect(resolveResumeDerivedBase({ derivedBase: "Piece", unitsPerBox: 3 }, 0)).toBeUndefined();
    expect(resolveResumeDerivedBase({ unitsPerBox: 3 }, 3)).toBeUndefined();
    expect(resolveResumeDerivedBase({ derivedBase: "  ", unitsPerBox: 3 }, 3)).toBeUndefined();
    expect(
      resolveResumeDerivedBase({ derivedBase: "Piece", unitLabel: "Case", unitsPerBox: 3 }, 3),
    ).toBeUndefined();
  });
  it("the order-edit snapshot keeps the marker across serialize / deserialize", () => {
    const staged = {
      draft: { k: draftItem() },
      unlisted: [],
      pendingDeletes: [],
      selectedCreditIds: [],
      creditsTouched: false,
      floorAcked: [],
    };
    const snap = makeEditItemsSnapshot({
      orderId: "o",
      staged,
      baseline: snapshotBaseline(undefined),
    });
    const back = deserializeEditItemsSnapshot(serializeEditItemsSnapshot(snap))!;
    expect(back.draft.k!.derivedBase).toBe("Piece");
    expect(unitPickerValue(back.draft.k!)).toBe("Piece");
  });
  it("a restored snapshot drops a marker that contradicts the line (a held unit, or not a string)", () => {
    const restore = (item: unknown) => {
      const staged = {
        draft: { k: item as DraftItem },
        unlisted: [],
        pendingDeletes: [],
        selectedCreditIds: [],
        creditsTouched: false,
        floorAcked: [],
      };
      const snap = makeEditItemsSnapshot({ orderId: "o", staged, baseline: "" });
      return deserializeEditItemsSnapshot(serializeEditItemsSnapshot(snap))!.draft.k!;
    };
    expect(restore(draftItem({ unitLabel: "Case", boxes: undefined })).derivedBase).toBeUndefined();
    expect(restore({ ...draftItem(), derivedBase: 5 }).derivedBase).toBeUndefined();
  });
});

describe("a pack-pieces line with NO marker is a PACK line, never a guessed Piece", () => {
  const stored = {
    id: "L1",
    productId: "p",
    qty: 2,
    boxes: 0,
    pieces: 2,
    unitsPerBox: 3,
    unitPrice: "10.00",
    status: "PENDING",
    product: { name: "x", unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" },
  };
  it("a stored boxes 0 / pieces 2 line hydrates as the pack option, boxes/pieces shown as a pack", () => {
    const item = hydrateFromOrder({ lineItems: [stored] }).draft.L1!;
    expect(item).toMatchObject({ boxes: 0, pieces: 2, boxSplit: true });
    expect(item.derivedBase).toBeUndefined();
    expect(unitPickerValue(item)).toBe("");
    expect(unitPickerValue(item)).toBe(packOption.value);
  });
  it("a cart line with boxes/pieces and no marker reads as the pack", () => {
    expect(unitPickerValue({ qty: 2, boxes: 0, pieces: 2 } as LineState)).toBe("");
  });
});

describe("the marker is part of the line identity (a merge never folds it into a pack line)", () => {
  const packItem = draftItem({ derivedBase: undefined, qty: 3, boxes: 1, pieces: 0 });
  it("a pack scan / tap does not merge into a derived-Piece line: it gets a fresh key", () => {
    const key = resolveDraftKeyForPick({ dk: draftItem() }, "p", null);
    expect(key).not.toBe("dk");
    expect(key.startsWith("new:")).toBe(true);
  });
  it("with both lines on one product the pack line is the merge target", () => {
    expect(resolveDraftKeyForPick({ dk: draftItem(), pk: packItem }, "p", null)).toBe("pk");
    expect(resolveDraftKeyForPick({ pk: packItem }, "p", null)).toBe("pk");
  });
  it("the async default-unit merge carries the marker onto the still-pending line", () => {
    const pending: LineState = { qty: 1, startOnDefaultUnit: 1, pendingTaps: 2 };
    const resolved = applyUnitOption(pending, pieceOption, 3);
    expect(resolved).toMatchObject({ derivedBase: "Piece", boxes: 0, pieces: 2, qty: 2 });
    const merged = mergeResolvedDefaults({ p: pending }, { p: pending }, { p: resolved });
    expect(merged.p).toMatchObject({ derivedBase: "Piece", boxes: 0, pieces: 2, qty: 2 });
    expect(unitPickerValue(merged.p!)).toBe("Piece");
  });
  it("a line holding the derived Piece is not waiting for a default unit", () => {
    expect(startsOnDefaultUnit({ startOnDefaultUnit: 1, qty: 1, derivedBase: "Piece" })).toBe(
      false,
    );
  });
});

describe("shapes around the pick", () => {
  it("cart: back to the pack is ONE whole pack, not a lone piece; a level pick clears the marker", () => {
    const one = applyUnitOption({ qty: 3, boxes: 1, pieces: 0 }, pieceOption, 3);
    const back = applyUnitOption(one, packOption, 3);
    expect(back).toMatchObject({ qty: 3, boxes: 1, pieces: 0 });
    expect(back.derivedBase).toBeUndefined();
    const level = derived.find((o) => o.value === "Case")!;
    const onCase = applyUnitOption(one, level, 3);
    expect(onCase).toMatchObject({ unitLabel: "Case", qty: 1 });
    expect(onCase.derivedBase).toBeUndefined();
    expect(onCase.boxes).toBeUndefined();
  });
  it("cart: re-applying the derived Piece the line already holds keeps its count", () => {
    const two = { ...applyUnitOption({ qty: 3, boxes: 1, pieces: 0 }, pieceOption, 3) };
    two.pieces = 2;
    two.qty = 2;
    const again = applyUnitOption(two, pieceOption, 3);
    expect(again).toMatchObject({ derivedBase: "Piece", boxes: 0, pieces: 2, qty: 2 });
  });
  it("edit: back to the pack is ONE whole pack; a level pick clears the marker", () => {
    const one = applyUnitPick(draftItem({ derivedBase: undefined }), pieceOption, 10);
    const back = applyUnitPick(one, packOption, 10);
    expect(back).toMatchObject({ qty: 3, boxes: 1, pieces: 0, boxSplit: true, unitPrice: 10 });
    expect(back.derivedBase).toBeUndefined();
    const level = derived.find((o) => o.value === "Case")!;
    const onCase = applyUnitPick(one, level, 10);
    expect(onCase).toMatchObject({ unitLabel: "Case", boxSplit: false });
    expect(onCase.derivedBase).toBeUndefined();
  });
});

describe("short pick: a stored derived-Piece line is an ordinary pieces line", () => {
  const stored = {
    id: "L1",
    productId: "p",
    qty: 2,
    boxes: 0,
    unitsPerBox: 3,
    unitLabel: null,
    subtotal: 6.67,
    product: { unitsPerBox: 3 },
  };
  it("keeps the piece stepper and prorates the stored subtotal; a stray marker on the row changes nothing", () => {
    const lines = shortPickLinesFromOrder({ lineItems: [stored] }, { L1: 2 });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.orderedQty).toBe(2);
    expect(isUnitAwareLine(line)).toBe(false);
    expect(buildDeliveries(lines, { L1: 1 })).toEqual([
      { orderItemId: "L1", productId: "p", type: "PARTIAL", qty: 1 },
    ]);
    expect(reconciledTotal(lines, { L1: 1 })).toBe(
      prorateLineSubtotal(6.67, 1, 2, 0, freeUnitSizeFor(stored)),
    );
    const withMarker = shortPickLinesFromOrder(
      { lineItems: [{ ...stored, derivedBase: "Piece" } as typeof stored] },
      { L1: 2 },
    );
    expect(withMarker).toEqual(lines);
  });
});

describe("picker wiring reads the marker", () => {
  const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
  it("UnitPickerRow shows the selection from unitPickerValue(line)", () => {
    const src = read("../components/UnitPickerRow.tsx");
    expect(src).toMatch(/unitPickerValue\(line\)/);
  });
  it("CartRow and DraftItemCard hand the marker to the picker", () => {
    expect(read("../components/CartRow.tsx")).toMatch(/derivedBase: line\.derivedBase/);
    expect(read("../components/edit-items/DraftItemCard.tsx")).toMatch(
      /derivedBase: item\.derivedBase/,
    );
  });
});

describe("parity: N pieces of the derived Piece preview exactly what the server bills", () => {
  const ladders = [
    {
      name: "3-pack @ $10",
      product: pack3,
      units: [lvl("Case", 12, null)],
      upb: 3,
    },
    {
      name: "12-case @ $10",
      product: { unit: "Case", unitsPerBox: 12, pricePerUnit: "10.00" },
      units: [lvl("Half", 6, null)],
      upb: 12,
    },
  ];
  for (const { name, product, units, upb } of ladders) {
    it(`${name}: 1..11 pieces, cart + order edit, no 1-cent drift`, () => {
      const options = buildUnitOptions(product, units, 1);
      const piece = options.find((o) => o.kind === "piece")!;
      expect(piece.derived?.n).toBe(upb);
      const pickedProduct: Product = {
        id: "p",
        name: "x",
        pricePerUnit: product.pricePerUnit,
        unitsPerBox: upb,
      };
      for (let n = 1; n <= 11; n += 1) {
        // the cart: N fast adds before the ladder loaded resolve to N of the default unit
        const line = applyUnitOption({ qty: 1, startOnDefaultUnit: 1, pendingTaps: n }, piece, upb);
        expect(line.unitLabel).toBeUndefined();
        expect(line.derivedBase).toBe(piece.value);
        expect(effectiveQty(line, upb)).toBe(n);
        const serverTotal = computeLineSubtotal({
          unitPrice: 10,
          qty: effectiveQty(line, upb),
          boxes: line.boxes ?? null,
          pieces: line.pieces ?? null,
          unitsPerBox: upb,
        });
        const preview = computeOrderTotal(
          { p: line },
          new Map([["p", pickedProduct]]),
          [],
          () => 1,
        ).total;
        expect(preview).toBe(serverTotal);
        expect(preview).toBe(ladderOptionLineTotal(piece, n));
        const plan = planBaseBilling(product, units, 1, n);
        expect(plan.mode).toBe("pack");
        expect(preview).toBe(plan.subtotal);

        // the order edit: the same N pieces typed on the picked line
        const item = applyPieceEdit(
          applyUnitPick(draftItem({ unitsPerBox: upb, derivedBase: undefined }), piece, 10),
          n,
          upb,
        );
        expect(item.derivedBase).toBe(piece.value);
        expect(
          computeLineSubtotal({
            unitPrice: item.unitPrice,
            qty: effectiveQty(item, upb),
            boxes: item.boxes ?? null,
            pieces: item.pieces ?? null,
            unitsPerBox: upb,
          }),
        ).toBe(serverTotal);
      }
    });
  }
  it("2 pieces of a 3-pack @ $10 is $6.67, not 2 x $3.33", () => {
    const line = applyUnitOption({ qty: 1, startOnDefaultUnit: 1, pendingTaps: 2 }, pieceOption, 3);
    const total = computeOrderTotal(
      { p: line },
      new Map([["p", { id: "p", name: "x", pricePerUnit: "10.00", unitsPerBox: 3 } as Product]]),
      [],
      () => 1,
    ).total;
    expect(total).toBe(6.67);
  });
});
