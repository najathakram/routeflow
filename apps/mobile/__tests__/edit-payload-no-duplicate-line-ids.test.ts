/**
 * F3 (second part): the order-edit payload builders must NEVER put the same line id in one items array,
 * because the API now refuses that with 400 DUPLICATE_LINE_ID. Builders covered here:
 *   - buildOrderItemDiff / stagedDiffItems (operator editor, lib/order-item-diff.ts + edit-items-draft.ts)
 *   - buyerSavePlan (buyer editor, lib/buyer-edit-items.ts)
 * New lines carry no id, so only the ids that ARE present are compared.
 */
import { buildOrderItemDiff, type OriginalLine } from "../lib/order-item-diff";
import {
  applyBoxEdit,
  applyPieceEdit,
  applyPickToDraft,
  hydrateFromOrder,
  orderOriginals,
  resolveDraftKeyForPick,
  stagedDiffItems,
  type DraftItem,
} from "../lib/edit-items-draft";
import { buyerSavePlan, type BuyerDraftItem } from "../lib/buyer-edit-items";

const ids = (items: ReadonlyArray<{ id?: string; orderItemId?: string }>): string[] =>
  items.map((i) => i.id ?? i.orderItemId).filter((v): v is string => !!v);
const expectUnique = (items: ReadonlyArray<{ id?: string; orderItemId?: string }>) => {
  const all = ids(items);
  expect(new Set(all).size).toBe(all.length);
};

const orig = (o: Partial<OriginalLine>): OriginalLine => ({
  id: "L1",
  productId: "P1",
  qty: 10,
  unitPrice: 5,
  name: null,
  ...o,
});
const row = (o: Partial<DraftItem>): DraftItem => ({
  productId: "P1",
  qty: 10,
  unitPrice: 5,
  catalogPrice: 5,
  name: "Widget",
  lineId: "L1",
  ...o,
});
const diff = (a: {
  draft?: Record<string, DraftItem>;
  pendingDeletes?: string[];
  originals?: OriginalLine[];
}) =>
  stagedDiffItems(
    { draft: a.draft ?? {}, unlisted: [], pendingDeletes: a.pendingDeletes ?? [] },
    a.originals ?? [orig({})],
  );

describe("order edit payload builders never emit a duplicate line id (F3)", () => {
  it("the same line edited twice (box then piece edit) is ONE entry for that id", () => {
    const base = row({ unitsPerBox: 12, qty: 120, boxes: 10, pieces: 0, boxSplit: true });
    const once = applyBoxEdit(base, 11, 12);
    const twice = applyPieceEdit(once, 3, 12);
    const out = diff({ draft: { L1: twice }, originals: [orig({ qty: 120 })] });
    expect(out.filter((i) => i.id === "L1")).toHaveLength(1);
    expectUnique(out);
  });

  it("a line removed then re-added: the pending delete is dropped, only one entry for the id", () => {
    const out = diff({ draft: { L1: row({ qty: 12 }) }, pendingDeletes: ["L1"] });
    expect(out.map((i) => `${i.id}:${i.action}`)).toEqual(["L1:UPDATE"]);
    expectUnique(out);
  });

  it("a line removed twice (the trash tapped on a restored snapshot) is ONE delete", () => {
    const out = diff({ pendingDeletes: ["L1", "L1"] });
    expect(out).toEqual([{ id: "L1", action: "DELETE" }]);
  });

  it("a delete queued AND a cancel queued for the same id emits one removal", () => {
    const out = buildOrderItemDiff({
      catalog: [],
      unlisted: [],
      originals: [orig({})],
      pendingDeletes: ["L1"],
      pendingCancels: ["L1"],
    });
    expect(ids(out)).toEqual(["L1"]);
  });

  it("a unit change that splits a line: the stored line keeps its id once, the other unit is an id-less add", () => {
    const saved = row({ qty: 10 });
    const key = resolveDraftKeyForPick({ L1: saved }, "P1", "Case");
    expect(key).not.toBe("L1"); // a unit pick never reuses the stored pack line's key
    const draft = {
      L1: { ...saved, qty: 9 },
      [key]: row({ lineId: undefined, unitLabel: "Case", qty: 2, unitPrice: 40 }),
    };
    const out = diff({ draft });
    expectUnique(out);
    expect(out.filter((i) => i.id === undefined)).toHaveLength(1);
  });

  it("a merged re-scan of an existing line is one entry, not a second row for the same id", () => {
    const draft = applyPickToDraft({ L1: row({ qty: 10 }) }, "L1", {
      productId: "P1",
      unitsPerBox: null,
      startPrice: 5,
      catalogPrice: 5,
      name: "Widget",
      level: "CASE",
    } as never);
    const out = diff({ draft });
    expectUnique(out);
    expect(out.filter((i) => i.id === "L1")).toHaveLength(1);
  });

  it("hydrated lines of the SAME product (two stored lines) keep their own distinct ids", () => {
    const order = {
      lineItems: [
        { id: "L1", productId: "P1", qty: 5, unitPrice: 5, status: "PENDING" },
        { id: "L2", productId: "P1", qty: 7, unitPrice: 6, status: "PENDING" },
      ],
    };
    const { draft } = hydrateFromOrder(order as never);
    const edited = Object.fromEntries(
      Object.entries(draft).map(([k, v]) => [k, { ...v, qty: v.qty + 1 }]),
    );
    const out = stagedDiffItems(
      { draft: edited, unlisted: [], pendingDeletes: [] },
      orderOriginals(order as never),
    );
    expect(ids(out).sort()).toEqual(["L1", "L2"]);
  });

  it("buyerSavePlan: two stored lines of one product go out with distinct orderItemIds", () => {
    const draft: Record<string, BuyerDraftItem> = {
      a: { productId: "P1", qty: 2, orderItemId: "L1" } as BuyerDraftItem,
      b: { productId: "P1", qty: 3, orderItemId: "L2" } as BuyerDraftItem,
      c: { productId: "P1", qty: 1 } as BuyerDraftItem,
      d: { productId: "P1", qty: 4 } as BuyerDraftItem,
    };
    const plan = buyerSavePlan([], draft);
    expect(plan.kind).toBe("replace");
    if (plan.kind === "replace") expectUnique(plan.items);
  });
});
