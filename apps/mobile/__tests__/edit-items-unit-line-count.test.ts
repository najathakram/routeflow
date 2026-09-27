import { readFileSync } from "fs";
import { join } from "path";
import {
  hydrateFromOrder,
  orderOriginals,
  repairBlockedLines,
  stagedDiffItems,
  unitLineCount,
  type BaselineOrderLike,
} from "../lib/edit-items-draft";

// #2231 / SA-388 (4): a stored unit line's COUNT is derived by ONE rule — `boxes` when it is a
// positive integer; else `qty / unitsPerBox` when the line's snapshot unitsPerBox >= 1 and qty
// is a whole multiple of it; else the line is LOCKED (no guess). SA-388 (5): every fixture here
// is server-shaped — qty in base pieces = count x factor (unit-line-build.ts stores the unit's
// factor as the line's unitsPerBox snapshot).

const caseLine = (over: Record<string, unknown>) =>
  ({
    id: "L1",
    productId: "p1",
    unitsPerBox: 12,
    unitLabel: "Case",
    unitPrice: 65,
    name: "Case widget",
    notes: null,
    status: "PENDING",
    product: { id: "p1", name: "Case widget", unit: "box", unitsPerBox: 12 },
    ...over,
  }) as any;

const orderOf = (...lineItems: any[]): BaselineOrderLike => ({ id: "o1", lineItems });

describe("unitLineCount (SA-388 rule 1)", () => {
  it.each([
    ["factor 12, boxes 3", { qty: 36, boxes: 3, unitsPerBox: 12 }, 3],
    ["factor 12, boxes 0 (the stored anomaly)", { qty: 36, boxes: 0, unitsPerBox: 12 }, 3],
    ["factor 12, boxes null", { qty: 36, boxes: null, unitsPerBox: 12 }, 3],
    ["factor 1 'Each', boxes null", { qty: 4, boxes: null, unitsPerBox: 1 }, 4],
  ])("%s => %i", (_n, li, expected) => {
    expect(unitLineCount(li)).toBe(expected);
  });

  it.each([
    ["qty not a whole multiple of the factor", { qty: 40, boxes: 0, unitsPerBox: 12 }],
    ["no snapshot factor", { qty: 36, boxes: 0, unitsPerBox: null }],
    ["fractional boxes, non-multiple qty", { qty: 40, boxes: 3.5, unitsPerBox: 12 }],
    // #2269 Opus/SA LOW (matches web #2220): nothing to count, or a non-integer basis.
    ["qty 0, boxes 0, factor 12", { qty: 0, boxes: 0, unitsPerBox: 12 }],
    ["negative qty", { qty: -12, boxes: 0, unitsPerBox: 12 }],
    ["fractional factor", { qty: 3, boxes: null, unitsPerBox: 1.5 }],
    ["fractional qty, factor 1", { qty: 2.5, boxes: null, unitsPerBox: 1 }],
  ])("%s => LOCKED (null)", (_n, li) => {
    expect(unitLineCount(li)).toBeNull();
  });
});

describe("hydrateFromOrder + orderOriginals share the count (#2231)", () => {
  it("a stored {qty 36, boxes 0, Case x12} line hydrates count 3, not 0; untouched sends nothing", () => {
    const order = orderOf(caseLine({ qty: 36, boxes: 0, pieces: 0 }));
    const { draft } = hydrateFromOrder(order);
    expect(draft.L1.qty).toBe(3);
    expect(draft.L1.needsRepair).toBeFalsy();
    const originals = orderOriginals(order);
    expect(originals[0].qty).toBe(3);
    expect(stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, originals)).toEqual([]);
    expect(repairBlockedLines(draft, originals)).toEqual([]);
  });

  it("a price-only edit 65 -> 90 on that line sends qty 3 (the COUNT) with its unitLabel", () => {
    const order = orderOf(caseLine({ qty: 36, boxes: 0, pieces: 0 }));
    const { draft } = hydrateFromOrder(order);
    const edited = { ...draft, L1: { ...draft.L1, unitPrice: 90 } };
    const items = stagedDiffItems(
      { draft: edited, unlisted: [], pendingDeletes: [] },
      orderOriginals(order),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "L1",
      action: "UPDATE",
      qty: 3,
      unitLabel: "Case",
      unitPrice: 90,
    });
  });

  it("promoBaseUnits seeds from the same count: {qty 36, boxes 0, promoFreeUnits 2} => 3", () => {
    const { draft } = hydrateFromOrder(orderOf(caseLine({ qty: 36, boxes: 0, promoFreeUnits: 2 })));
    expect(draft.L1.promoBaseUnits).toBe(3);
  });

  it("a non-unit line is unchanged: qty stays the stored qty", () => {
    const order = orderOf(caseLine({ unitLabel: null, qty: 7, boxes: null, unitsPerBox: null }));
    expect(hydrateFromOrder(order).draft.L1.qty).toBe(7);
    expect(orderOriginals(order)[0].qty).toBe(7);
  });
});

describe("a LOCKED unit line (#2231, SA-388 rule 1)", () => {
  const locked = () => orderOf(caseLine({ qty: 40, boxes: 0, pieces: 0 }));

  it("hydrates flagged needsRepair; untouched, it sends nothing and blocks nothing", () => {
    const order = locked();
    const { draft } = hydrateFromOrder(order);
    expect(draft.L1.needsRepair).toBe(true);
    const originals = orderOriginals(order);
    expect(stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, originals)).toEqual([]);
    expect(repairBlockedLines(draft, originals)).toEqual([]);
  });

  it.each([
    ["a price-only edit", { unitPrice: 90 }],
    ["a note-only edit", { notes: "leave at door" }],
    ["a qty edit", { qty: 1 }],
  ])("%s is blocked (the screen refuses the save, no request)", (_n, patch) => {
    const order = locked();
    const { draft } = hydrateFromOrder(order);
    const edited = { ...draft, L1: { ...draft.L1, ...patch } };
    expect(repairBlockedLines(edited, orderOriginals(order))).toEqual(["Case widget"]);
  });

  it("removing the locked line is still allowed (DELETE needs no count)", () => {
    const order = locked();
    hydrateFromOrder(order);
    // The screen's removeLine takes the line OUT of the draft and queues its id (B805: a
    // pendingDelete whose id still survives in the draft is dropped — the surviving state wins).
    expect(repairBlockedLines({}, orderOriginals(order))).toEqual([]);
    expect(
      stagedDiffItems({ draft: {}, unlisted: [], pendingDeletes: ["L1"] }, orderOriginals(order)),
    ).toEqual([{ id: "L1", action: "DELETE" }]);
  });
});

describe("SA-388a: a blocked LOCKED line refuses the WHOLE save and keeps every other edit (#2231)", () => {
  it("a moved stepper on the locked line + a price edit on a healthy line: blocked by name, draft untouched", () => {
    const order = orderOf(
      caseLine({ qty: 40, boxes: 0, pieces: 0 }),
      caseLine({ id: "L2", productId: "p2", name: "Good case", qty: 36, boxes: 3, pieces: 0 }),
    );
    const { draft } = hydrateFromOrder(order);
    expect(draft.L1.needsRepair).toBe(true);
    expect(draft.L2.qty).toBe(3);
    const edited = {
      ...draft,
      L1: { ...draft.L1, qty: draft.L1.qty + 1 }, // the stepper may move (SA-388a)
      L2: { ...draft.L2, unitPrice: 80 },
    };
    const before = JSON.stringify(edited);
    const originals = orderOriginals(order);
    expect(repairBlockedLines(edited, originals)).toEqual(["Case widget"]);
    // Pure: the check never discards or rewrites the operator's staged edits.
    expect(JSON.stringify(edited)).toBe(before);
    // Once the locked line is removed, the SAME draft saves the healthy line's edit normally.
    const { L1: _removed, ...rest } = edited;
    expect(repairBlockedLines(rest, originals)).toEqual([]);
    expect(
      stagedDiffItems({ draft: rest, unlisted: [], pendingDeletes: ["L1"] }, originals),
    ).toEqual([
      { id: "L1", action: "DELETE" },
      expect.objectContaining({
        id: "L2",
        action: "UPDATE",
        qty: 3,
        unitPrice: 80,
        unitLabel: "Case",
      }),
    ]);
  });
});

describe("edit-items.tsx source pin: save() refuses a blocked locked line before any request (#2231)", () => {
  const src = readFileSync(
    join(__dirname, "../app/(operator)/(tabs)/orders/[id]/edit-items.tsx"),
    "utf8",
  );

  it("calls repairBlockedLines and shows 'needs repair' before updateMut.mutate", () => {
    const saveAt = src.indexOf("const save = () => {");
    const guardAt = src.indexOf("repairBlockedLines(", saveAt);
    const mutateAt = src.indexOf("updateMut.mutate(", saveAt);
    expect(saveAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(saveAt);
    expect(guardAt).toBeLessThan(mutateAt);
    expect(src.slice(guardAt, mutateAt)).toMatch(/needs repair/);
  });

  it("SA-388a (1): the refusal only toasts and returns — no setDraft/clearSnapshot/leaveEditor on that path", () => {
    const saveAt = src.indexOf("const save = () => {");
    const guardAt = src.indexOf("repairBlockedLines(", saveAt);
    const guardLine = src.slice(
      src.indexOf("\n", guardAt) + 1,
      src.indexOf(";\n", src.indexOf("\n", guardAt)) + 1,
    );
    expect(guardLine).toMatch(
      /^\s*if \(repair\.length\) return showToast\(`\$\{repair\.join\(", "\)\} needs repair — not saved\.`\);$/,
    );
  });
});
