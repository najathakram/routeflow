/**
 * `lib/edit-items-draft.ts` — the pure layer behind the order-item editor.
 *
 * Pure-logic only (mobile Jest is `testEnvironment: "node"`): the dirty check,
 * the Save payload, the on-device snapshot and the drawer's rows. The screen's
 * JSX wiring is pinned separately by `edit-items-drawer.test.ts`.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { computeLineSubtotal } from "@routeflow/pricing";
import { buildOrderItemDiff } from "../lib/order-item-diff";
import {
  deserializeEditItemsSnapshot,
  draftTrayRows,
  editItemsSnapshotKey,
  hasUnsavedItemEdits,
  hasUnsavedWork,
  hydrateFromOrder,
  isSnapshotStale,
  makeEditItemsSnapshot,
  newDraftKey,
  orderOriginals,
  pickerTrayExpandedHeight,
  resolveDraftKeyForPick,
  editItemsSnapshotUserPrefix,
  serializeEditItemsSnapshot,
  shouldRehydrateFromOrder,
  snapshotBaseline,
  stagedDiffItems,
  EDIT_ITEMS_SNAPSHOT_TTL_MS,
  type BaselineOrderLike,
  type DraftItem,
  type StagedEdit,
  type UnlistedDraft,
} from "../lib/edit-items-draft";

// A two-line order: one boxed BUY_N_GET_M line, one loose line.
function orderFixture(): BaselineOrderLike {
  return {
    id: "o1",
    updatedAt: "2026-09-14T00:00:00.000Z",
    lineItems: [
      {
        id: "L1",
        productId: "p1",
        qty: 24,
        unitPrice: 24,
        name: "Boxed widget",
        notes: null,
        status: "PENDING",
      },
      {
        id: "L2",
        productId: "p2",
        qty: 3,
        unitPrice: 5,
        name: "Loose widget",
        notes: null,
        status: "PENDING",
      },
    ],
  };
}

function draftFixture(): Record<string, DraftItem> {
  return {
    p1: {
      productId: "p1",
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      unitPrice: 24,
      catalogPrice: 24,
      name: "Boxed widget",
      lineId: "L1",
      boxSplit: true,
      promoFreeUnits: 1,
      promoBaseUnits: 2,
    },
    p2: {
      productId: "p2",
      qty: 3,
      unitsPerBox: null,
      unitPrice: 5,
      catalogPrice: 5,
      name: "Loose widget",
      lineId: "L2",
    },
  };
}

function stagedFixture(over: Partial<StagedEdit> = {}): StagedEdit {
  return {
    draft: draftFixture(),
    unlisted: [],
    pendingDeletes: [],
    selectedCreditIds: [],
    creditsTouched: false,
    floorAcked: [],
    ...over,
  };
}

describe("edit-items-draft: the dirty check is the Save payload (REG-EDIT-DRAFT-A)", () => {
  it("REG-EDIT-DRAFT-A: hasUnsavedItemEdits is false for a freshly hydrated draft and true after a qty change", () => {
    const order = orderFixture();
    const originals = orderOriginals(order);
    const staged = stagedFixture();
    expect(hasUnsavedItemEdits(staged, originals)).toBe(false);

    const bumped = stagedFixture();
    bumped.draft.p2 = { ...bumped.draft.p2, qty: 4 };
    expect(hasUnsavedItemEdits(bumped, originals)).toBe(true);
  });

  it("REG-EDIT-DRAFT-A: hasUnsavedItemEdits covers a trash delete and a scanned add; hasUnsavedWork adds creditsTouched", () => {
    const originals = orderOriginals(orderFixture());

    const trashed = stagedFixture({ pendingDeletes: ["L1"] });
    delete trashed.draft.p1;
    expect(hasUnsavedItemEdits(trashed, originals)).toBe(true);

    const added = stagedFixture();
    added.draft.p3 = {
      productId: "p3",
      qty: 1,
      unitsPerBox: null,
      unitPrice: 9,
      catalogPrice: 9,
      name: "Scanned widget",
    };
    expect(hasUnsavedItemEdits(added, originals)).toBe(true);

    // save()'s own early return: `items.length === 0 && !creditsTouched`.
    const creditsOnly = stagedFixture({ creditsTouched: true, selectedCreditIds: ["c1"] });
    expect(hasUnsavedItemEdits(creditsOnly, originals)).toBe(false);
    expect(hasUnsavedWork(creditsOnly, originals)).toBe(true);
    expect(hasUnsavedWork(stagedFixture(), originals)).toBe(false);
  });

  it("REG-EDIT-DRAFT-A: stagedDiffItems reproduces save()'s payload exactly", () => {
    const order = orderFixture();
    const originals = orderOriginals(order);
    const unlisted: UnlistedDraft[] = [{ id: "u1", name: "Pallet fee", unitPrice: 12, qty: 1 }];
    const draft = draftFixture();
    draft.p1 = { ...draft.p1, unitPrice: 21, overrideReason: "Damaged case" };
    draft.p2 = { ...draft.p2, notes: "Leave at the side door" };

    // The hand-built mapping edit-items.tsx's save() used to inline, verbatim.
    const expected = buildOrderItemDiff({
      catalog: [
        {
          lineId: "L1",
          productId: "p1",
          qty: 24,
          boxes: 2,
          pieces: 0,
          boxSplit: true,
          unitPrice: 21,
          basePrice: 24,
          overrideReason: "Damaged case",
          substituteProductId: undefined,
          notes: undefined,
        },
        {
          lineId: "L2",
          productId: "p2",
          qty: 3,
          boxes: null,
          pieces: null,
          boxSplit: false,
          unitPrice: 5,
          basePrice: 5,
          overrideReason: undefined,
          substituteProductId: undefined,
          notes: "Leave at the side door",
        },
      ],
      unlisted: [
        { lineId: undefined, name: "Pallet fee", qty: 1, unitPrice: 12, notes: undefined },
      ],
      originals,
      pendingDeletes: [],
      pendingCancels: [],
    });

    expect(stagedDiffItems({ draft, unlisted, pendingDeletes: [] }, originals)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it("REG-MSCAN-M1: orderOriginals threads overrideReason through, so a reason-only correction saves and a re-hydrated unchanged override does not false-positive", () => {
    const order = orderFixture();
    order.lineItems = [
      { ...order.lineItems![0], overrideReason: "Damaged case" },
      order.lineItems![1],
    ];
    const originals = orderOriginals(order);
    expect(originals.find((o) => o.id === "L1")?.overrideReason).toBe("Damaged case");

    // Re-hydrated draft carries the SAME saved reason, price/qty untouched — must
    // be silent (this is the false-positive M1's own fix could have introduced
    // if orderOriginals didn't carry overrideReason through from the server line).
    const untouched = draftFixture();
    untouched.p1 = { ...untouched.p1, overrideReason: "Damaged case" };
    expect(
      stagedDiffItems({ draft: untouched, unlisted: [], pendingDeletes: [] }, originals),
    ).toEqual([]);

    // Operator corrects ONLY the reason text — unitPrice identical to the
    // original 24. Before the fix this was dropped silently (M1). unitPrice
    // is NOT in the payload (F3): sending it on a reason-only edit would read
    // as a re-price to the server's isManualOverride check (R9).
    const reasonOnly = draftFixture();
    reasonOnly.p1 = { ...reasonOnly.p1, overrideReason: "Damaged case, restocking fee waived" };
    expect(
      stagedDiffItems({ draft: reasonOnly, unlisted: [], pendingDeletes: [] }, originals),
    ).toEqual([
      {
        id: "L1",
        action: "UPDATE",
        qty: 24,
        boxes: 2,
        pieces: 0,
        overrideReason: "Damaged case, restocking fee waived",
      },
    ]);
  });
});

describe("edit-items-draft: the on-device snapshot (REG-EDIT-DRAFT-B)", () => {
  it("REG-EDIT-DRAFT-B: serialize -> deserialize round-trips every staged field", () => {
    const staged = stagedFixture({
      unlisted: [{ id: "u1", name: "Pallet fee", unitPrice: 12, qty: 1, notes: "n", lineId: "L9" }],
      pendingDeletes: ["L7"],
      selectedCreditIds: ["c1", "c2"],
      creditsTouched: true,
      floorAcked: ["L1"],
    });
    staged.draft.p1 = {
      ...staged.draft.p1,
      unit: "case",
      overrideReason: "Damaged case",
      notes: "handle with care",
      substituteProductId: "p9",
      averageCost: "3.25",
      category: "DRY",
      sellBy: "unit",
    };
    const snapshot = makeEditItemsSnapshot({
      orderId: "o1",
      staged,
      baseline: snapshotBaseline(orderFixture()),
      orderUpdatedAt: "2026-09-14T00:00:00.000Z",
      now: 1_700_000_000_000,
    });

    const back = deserializeEditItemsSnapshot(serializeEditItemsSnapshot(snapshot));
    expect(back).toEqual(snapshot);
    expect(back?.draft.p1.promoFreeUnits).toBe(1);
    expect(back?.draft.p1.promoBaseUnits).toBe(2);
    expect(back?.draft.p1.substituteProductId).toBe("p9");
    expect(back?.floorAcked).toEqual(["L1"]);
  });

  it("REG-EDIT-DRAFT-B: deserializeEditItemsSnapshot never throws on hostile input", () => {
    const hostile = [
      null,
      undefined,
      "",
      "not json",
      "[]",
      "{}",
      JSON.stringify({ v: 99, orderId: "o1", savedAt: 1, baseline: "" }),
      JSON.stringify({ v: 1, orderId: "o1", savedAt: 1, baseline: "", draft: null }),
      JSON.stringify({ v: 1, orderId: "", savedAt: 1, baseline: "", draft: {} }),
    ];
    for (const raw of hostile) {
      expect(() => deserializeEditItemsSnapshot(raw as string | null)).not.toThrow();
      expect(deserializeEditItemsSnapshot(raw as string | null)).toBeNull();
    }
  });

  it("REG-EDIT-DRAFT-B: a fresh snapshot against the same order is not stale", () => {
    const order = orderFixture();
    const now = 1_700_000_000_000;
    const snapshot = makeEditItemsSnapshot({
      orderId: "o1",
      staged: stagedFixture(),
      baseline: snapshotBaseline(order),
      now: now - 60_000,
    });
    expect(isSnapshotStale(snapshot, order, now)).toBe(false);

    // A STATUS-only change must not trip it — status is not in the fingerprint.
    const restatused: BaselineOrderLike = {
      ...order,
      lineItems: (order.lineItems ?? []).map((li) => ({ ...li, status: "CONFIRMED" })),
    };
    expect(isSnapshotStale(snapshot, restatused, now)).toBe(false);
  });

  it("REG-EDIT-DRAFT-B: a server line qty / unitPrice / name / notes / removal change makes it stale", () => {
    const order = orderFixture();
    const now = 1_700_000_000_000;
    const snapshot = makeEditItemsSnapshot({
      orderId: "o1",
      staged: stagedFixture(),
      baseline: snapshotBaseline(order),
      now: now - 60_000,
    });
    const mutate = (patch: Record<string, unknown>): BaselineOrderLike => ({
      ...order,
      lineItems: [{ ...(order.lineItems ?? [])[0], ...patch }, (order.lineItems ?? [])[1]],
    });

    expect(isSnapshotStale(snapshot, mutate({ qty: 36 }), now)).toBe(true);
    expect(isSnapshotStale(snapshot, mutate({ unitPrice: 25 }), now)).toBe(true);
    expect(isSnapshotStale(snapshot, mutate({ name: "Renamed" }), now)).toBe(true);
    expect(isSnapshotStale(snapshot, mutate({ notes: "new note" }), now)).toBe(true);
    expect(
      isSnapshotStale(snapshot, { ...order, lineItems: [(order.lineItems ?? [])[1]] }, now),
    ).toBe(true);

    expect(isSnapshotStale(snapshot, { ...order, id: "other" }, now)).toBe(true);
    expect(isSnapshotStale({ ...snapshot, v: 0 }, order, now)).toBe(true);
    expect(isSnapshotStale(snapshot, order, now + EDIT_ITEMS_SNAPSHOT_TTL_MS)).toBe(true);
    expect(isSnapshotStale(snapshot, null, now)).toBe(true);
    expect(isSnapshotStale(snapshot, undefined, now)).toBe(true);
    expect(isSnapshotStale(null, order, now)).toBe(true);
  });

  it("REG-EDIT-DRAFT-B: snapshotBaseline ignores CANCELLED lines and normalises string numbers", () => {
    const order = orderFixture();
    const withCancelled: BaselineOrderLike = {
      ...order,
      lineItems: [
        ...(order.lineItems ?? []),
        {
          id: "L3",
          productId: "p3",
          qty: 5,
          unitPrice: 1,
          name: "Cancelled",
          status: "CANCELLED",
        },
      ],
    };
    expect(snapshotBaseline(withCancelled)).toBe(snapshotBaseline(order));

    const stringy: BaselineOrderLike = {
      ...order,
      lineItems: (order.lineItems ?? []).map((li) => ({
        ...li,
        qty: String(li.qty),
        unitPrice: Number(li.unitPrice).toFixed(2),
      })),
    };
    expect(snapshotBaseline(stringy)).toBe(snapshotBaseline(order));

    // Sorted by id, so the server returning the lines in another order is
    // not a change.
    const reversed: BaselineOrderLike = {
      ...order,
      lineItems: [...(order.lineItems ?? [])].reverse(),
    };
    expect(snapshotBaseline(reversed)).toBe(snapshotBaseline(order));
  });

  it("REG-EDIT-DRAFT-B: editItemsSnapshotKey is user- and order-scoped with an anon fallback", () => {
    expect(editItemsSnapshotKey("o1", "u1")).toBe("rf.edit-items.v1:u1:o1");
    expect(editItemsSnapshotKey("o1", null)).toBe("rf.edit-items.v1:anon:o1");
    expect(editItemsSnapshotKey("o1", undefined)).toBe("rf.edit-items.v1:anon:o1");
    expect(editItemsSnapshotKey("o1", "u1")).not.toBe(editItemsSnapshotKey("o2", "u1"));
    expect(editItemsSnapshotKey("o1", "u1")).not.toBe(editItemsSnapshotKey("o1", "u2"));
  });

  it("REG-EDIT-SWEEP-A: every key one user can own starts with that user's prefix, and no other user's does", () => {
    const prefix = editItemsSnapshotUserPrefix("u1");
    expect(prefix).toBe("rf.edit-items.v1:u1:");
    // The key helper is DEFINED in terms of the prefix, so a sweep over the
    // prefix cannot miss a key the editor writes.
    for (const orderId of ["o1", "o2", "0", "a:b"]) {
      expect(editItemsSnapshotKey(orderId, "u1").startsWith(prefix)).toBe(true);
    }
    expect(editItemsSnapshotKey("o1", "u2").startsWith(prefix)).toBe(false);
    expect(editItemsSnapshotKey("o1", null).startsWith(prefix)).toBe(false);
    // Trailing separator: "u1" must not sweep "u10"'s staged edits.
    expect(editItemsSnapshotKey("o1", "u10").startsWith(prefix)).toBe(false);
    expect(editItemsSnapshotUserPrefix(null)).toBe("rf.edit-items.v1:anon:");
    expect(editItemsSnapshotUserPrefix(undefined)).toBe("rf.edit-items.v1:anon:");
  });
});

/**
 * FINDING 1 (money) — a background refetch of the order used to wipe the
 * staged edit AND then delete its on-disk snapshot. `shouldRehydrateFromOrder`
 * is the rule the screen's `[order]` effect now opens with.
 */
describe("edit-items-draft: the hydration guard (REG-EDIT-REHYDRATE)", () => {
  it("REG-EDIT-REHYDRATE: the FIRST hydration always runs, even though a just-loaded order reads as dirty", () => {
    // This is not hypothetical: on the render where `order` first arrives the
    // draft is still empty, and an empty draft against real server lines is a
    // full set of DELETEs — i.e. `dirty === true`.
    const order = orderFixture();
    const emptyDraftIsDirty = hasUnsavedWork(stagedFixture({ draft: {} }), orderOriginals(order));
    expect(emptyDraftIsDirty).toBe(true);
    expect(
      shouldRehydrateFromOrder({ hydrated: false, dirty: emptyDraftIsDirty, justSaved: false }),
    ).toBe(true);
  });

  it("REG-EDIT-REHYDRATE: a background refetch never overwrites staged work", () => {
    const order = orderFixture();
    const staged = stagedFixture();
    staged.draft.p2 = { ...staged.draft.p2, qty: 9 };
    expect(hasUnsavedWork(staged, orderOriginals(order))).toBe(true);
    expect(shouldRehydrateFromOrder({ hydrated: true, dirty: true, justSaved: false })).toBe(false);
  });

  it("REG-EDIT-REHYDRATE: a refetch onto a CLEAN editor, and the post-save refetch, both re-hydrate", () => {
    expect(shouldRehydrateFromOrder({ hydrated: true, dirty: false, justSaved: false })).toBe(true);
    // A saved edit is already on the server — the refetch IS the new truth.
    expect(shouldRehydrateFromOrder({ hydrated: true, dirty: true, justSaved: true })).toBe(true);
  });
});

describe("edit-items-draft: the picker's drawer (REG-EDIT-DRAFT-C)", () => {
  it("REG-EDIT-DRAFT-C: draftTrayRows nets BOGO free units off the drawer subtotal", () => {
    const draft = draftFixture();
    const rows = draftTrayRows({ draft, unlisted: [], scanOrder: [] });
    const promoRow = rows.find((r) => r.id === "p1");

    const netted = computeLineSubtotal({
      unitPrice: 24,
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      freeUnits: 1,
    });
    const full = computeLineSubtotal({
      unitPrice: 24,
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
    });
    expect(netted).not.toBe(full);
    expect(promoRow?.subtotal).toBe(netted);

    // A pending SUBSTITUTION earns nothing: the promo snapshot belongs to the
    // product being replaced.
    const substituted = draftFixture();
    substituted.p1 = { ...substituted.p1, substituteProductId: "p9" };
    const subRow = draftTrayRows({ draft: substituted, unlisted: [], scanOrder: [] }).find(
      (r) => r.id === "p1",
    );
    expect(subRow?.subtotal).toBe(full);
  });

  it("REG-EDIT-DRAFT-C: draftTrayRows orders scanned lines newest-first and includes unlisted rows", () => {
    const draft = draftFixture();
    draft.p3 = {
      productId: "p3",
      qty: 2,
      unitsPerBox: null,
      unitPrice: 7,
      catalogPrice: 7,
      name: "Third widget",
    };
    const unlisted: UnlistedDraft[] = [{ id: "u1", name: "Pallet fee", unitPrice: 12, qty: 1 }];

    const rows = draftTrayRows({ draft, unlisted, scanOrder: ["p2", "p1"] });
    expect(rows[0].id).toBe("p2");
    expect(rows[1].id).toBe("p1");

    const tail = rows.slice(2).map((r) => r.id);
    expect(tail).toContain("p3");
    expect(tail).toContain("u1");

    const unlistedRow = rows.find((r) => r.id === "u1");
    expect(unlistedRow?.unlisted).toBe(true);
    expect(unlistedRow?.subtotal).toBe(computeLineSubtotal({ unitPrice: 12, qty: 1 }));
  });

  it("REG-EDIT-DRAWER-OVERRIDE: a drawer row prices an overridden line at its STORED price, not catalogue", () => {
    // Every other fixture on this surface sets catalogPrice === unitPrice, so
    // nothing here would notice if the drawer ever priced an overridden line
    // at list. On the EDIT surface the line's stored `unitPrice` is what the
    // order actually charges (lib/edit-items-draft.ts `draftTrayRows`).
    const draft = draftFixture();
    draft.p4 = {
      productId: "p4",
      qty: 6,
      unitsPerBox: null,
      unitPrice: 4,
      catalogPrice: 5,
      name: "Discounted widget",
    };

    const row = draftTrayRows({ draft, unlisted: [], scanOrder: [] }).find((r) => r.id === "p4");

    const atOverride = computeLineSubtotal({ unitPrice: 4, qty: 6 });
    const atCatalogue = computeLineSubtotal({ unitPrice: 5, qty: 6 });
    expect(atOverride).not.toBe(atCatalogue);
    expect(row?.subtotal).toBe(atOverride);
  });

  it("REG-EDIT-DRAFT-C: pickerTrayExpandedHeight never covers the camera viewfinder", () => {
    for (const win of [
      { width: 390, height: 844 },
      { width: 375, height: 667 },
      { width: 428, height: 926 },
    ]) {
      // BarcodeScanner.tsx: WINDOW_SIZE = width * 0.7, top band =
      // (height - WINDOW_SIZE) / 2 - 40, then the clear window itself.
      const scanWindow = win.width * 0.7;
      const viewfinderBottom = (win.height - scanWindow) / 2 - 40 + scanWindow;
      const h = pickerTrayExpandedHeight(win);
      expect(h).toBeLessThanOrEqual(win.height - viewfinderBottom);
      expect(h).toBeGreaterThanOrEqual(200);
    }
  });
});

/**
 * B707 — a stored line's pack is its OWN snapshot (`li.unitsPerBox`), never
 * the live product's: reading the live product ALONE (the pre-fix bug)
 * refused every save of an order holding a unit line (409 UNIT_AWARE_LINE,
 * since the fabricated qty change carried no unitLabel) and silently
 * re-denominated a repacked legacy split line.
 */
describe("edit-items-draft: hydrateFromOrder reads a line's OWN pack snapshot (B707)", () => {
  it("B707a: a unit line (boxes 3, snapshot 288, 'Case') hydrates unitsPerBox/unitLabel from ITS OWN line, not the live product's now-12 pack — untouched, no UPDATE", () => {
    const order: BaselineOrderLike = {
      id: "o1",
      lineItems: [
        {
          id: "L1",
          productId: "p1",
          qty: 864,
          boxes: 3,
          pieces: 0,
          unitsPerBox: 288,
          unitLabel: "Case",
          unitPrice: 20,
          name: "Case widget",
          notes: null,
          status: "PENDING",
          product: { id: "p1", name: "Case widget", unit: "box", unitsPerBox: 12 },
        } as any,
      ],
    };

    // B775: the draft record is keyed by the line's OWN id (L1), never
    // productId (p1) — a units_v1 two-level order can carry a second line
    // for the SAME product, which a productId key would silently collapse.
    const { draft } = hydrateFromOrder(order);
    expect(draft.L1.unitsPerBox).toBe(288);
    expect(draft.L1.unitLabel).toBe("Case");
    expect(draft.L1.boxes).toBe(3);

    const originals = orderOriginals(order);
    expect(stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, originals)).toEqual([]);
  });

  it("B707b: editing the same unit line's box count 3 -> 4 sends {id, qty: <count>, unitLabel}, never the piece-expanded 1152", () => {
    const order: BaselineOrderLike = {
      id: "o1",
      lineItems: [
        {
          id: "L1",
          productId: "p1",
          qty: 864,
          boxes: 3,
          pieces: 0,
          unitsPerBox: 288,
          unitLabel: "Case",
          unitPrice: 20,
          name: "Case widget",
          notes: null,
          status: "PENDING",
          product: { id: "p1", name: "Case widget", unit: "box", unitsPerBox: 12 },
        } as any,
      ],
    };
    const { draft } = hydrateFromOrder(order);
    const edited = { ...draft, L1: { ...draft.L1, boxes: 4 } };
    const originals = orderOriginals(order);

    expect(stagedDiffItems({ draft: edited, unlisted: [], pendingDeletes: [] }, originals)).toEqual(
      [{ id: "L1", action: "UPDATE", qty: 4, unitLabel: "Case" }],
    );
  });

  it("B707c: a repacked legacy split line (boxes 2, pieces 3, snapshot 12) prices off ITS OWN 12, not the live product's now-24 pack — untouched, no UPDATE", () => {
    const order: BaselineOrderLike = {
      id: "o1",
      lineItems: [
        {
          id: "L2",
          productId: "p2",
          qty: 27,
          boxes: 2,
          pieces: 3,
          unitsPerBox: 12,
          unitPrice: 10,
          name: "Split widget",
          notes: null,
          status: "PENDING",
          product: { id: "p2", name: "Split widget", unit: "box", unitsPerBox: 24 },
        } as any,
      ],
    };

    const { draft } = hydrateFromOrder(order);
    expect(draft.L2.unitsPerBox).toBe(12);

    const atOwnPack = computeLineSubtotal({
      unitPrice: 10,
      qty: 27,
      boxes: 2,
      pieces: 3,
      unitsPerBox: 12,
    });
    const atLivePack = computeLineSubtotal({
      unitPrice: 10,
      qty: 27,
      boxes: 2,
      pieces: 3,
      unitsPerBox: 24,
    });
    expect(atOwnPack).toBe(22.5);
    expect(atLivePack).toBe(21.25);
    const row = draftTrayRows({ draft, unlisted: [], scanOrder: [] }).find((r) => r.id === "L2");
    expect(row?.subtotal).toBe(atOwnPack);

    const originals = orderOriginals(order);
    expect(stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, originals)).toEqual([]);
  });

  it("B707d: a line with no OWN pack snapshot still falls back to the live product's pack (a fresh/never-repacked line is unaffected)", () => {
    const order: BaselineOrderLike = {
      id: "o1",
      lineItems: [
        {
          id: "L3",
          productId: "p3",
          qty: 12,
          unitPrice: 5,
          name: "New-ish widget",
          notes: null,
          status: "PENDING",
          product: { id: "p3", name: "New-ish widget", unit: "box", unitsPerBox: 12 },
        } as any,
      ],
    };
    const { draft } = hydrateFromOrder(order);
    expect(draft.L3.unitsPerBox).toBe(12);
  });
});

/**
 * B775 (CRITICAL, live for every tenant — SA-101/SA-103): `hydrateFromOrder`
 * used to key the draft by `productId`. A second line for the same product
 * (units_v1's Case+pack two-level model, OR a plain non-unit order — create()
 * maps dto.items one OrderItem per entry with no dedupe and no
 * @@unique([orderId, productId])) silently overwrote the first at hydration.
 * `order-item-diff.ts` then read the dropped line's id as absent from the
 * surviving set and emitted `{id, action:"DELETE"}` for it — on a ZERO-EDIT
 * Save, since the collision happens at hydration, before any operator
 * interaction. Fix: key the draft (and every derived map/render key) by the
 * line's own id.
 */
describe("edit-items-draft: two same-product lines never collide (B775)", () => {
  // Matches the reported live repro exactly: line a is a Case at $80 (a
  // units_v1 unit-aware line), line b a pack at $36, same product — a
  // no-op save took the order from $116 to $36 (line a silently deleted).
  function twoLineOrder(overrides: { line1?: any; line2?: any } = {}): BaselineOrderLike {
    return {
      id: "o1",
      lineItems: [
        {
          id: "La",
          productId: "shared-product",
          qty: 288,
          boxes: 1,
          pieces: 0,
          unitsPerBox: 288,
          unitLabel: "Case",
          unitPrice: 80,
          name: "Widget (Case)",
          notes: null,
          status: "PENDING",
          product: { id: "shared-product", name: "Widget", unit: "box", unitsPerBox: 12 },
          ...overrides.line1,
        },
        {
          id: "Lb",
          productId: "shared-product",
          qty: 3,
          unitPrice: 12,
          name: "Widget (pack)",
          notes: null,
          status: "PENDING",
          product: { id: "shared-product", name: "Widget", unit: "box", unitsPerBox: 12 },
          ...overrides.line2,
        },
      ] as any,
    };
  }

  it("BOTH lines survive hydration, each keyed by its OWN id — never collapsed to one entry", () => {
    const { draft } = hydrateFromOrder(twoLineOrder());
    expect(Object.keys(draft).sort()).toEqual(["La", "Lb"]);
    expect(draft.La.qty).toBe(288);
    expect(draft.Lb.qty).toBe(3);
  });

  it("a ZERO-EDIT save sends ZERO DELETEs and ZERO UPDATEs (the exact live money bug: a no-op Save deleted a real billed line)", () => {
    const order = twoLineOrder();
    const { draft } = hydrateFromOrder(order);
    const originals = orderOriginals(order);
    const items = stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, originals);
    expect(items).toEqual([]);
    expect(items.filter((i: any) => i.action === "DELETE")).toEqual([]);
    expect(items.filter((i: any) => i.action === "UPDATE")).toEqual([]);
  });

  it("editing ONE line (line b's qty 3 -> 5) sends an UPDATE for ONLY that line — the other (the Case line) is byte-identical to its original, no DELETE anywhere", () => {
    const order = twoLineOrder();
    const { draft } = hydrateFromOrder(order);
    const edited = { ...draft, Lb: { ...draft.Lb, qty: 5 } };
    const originals = orderOriginals(order);
    const items = stagedDiffItems({ draft: edited, unlisted: [], pendingDeletes: [] }, originals);
    expect(items).toEqual([{ id: "Lb", action: "UPDATE", qty: 5 }]);
    // Line a (the Case line) never appears in the payload at all — untouched
    // lines emit nothing, and it is specifically NOT a DELETE.
    expect(items.some((i: any) => i.id === "La")).toBe(false);
  });

  it("a single-line order is unaffected — the fix is a pure superset, not a behavior change for the common case", () => {
    const order: BaselineOrderLike = {
      id: "o1",
      lineItems: [
        {
          id: "Lsolo",
          productId: "p-solo",
          qty: 5,
          unitPrice: 10,
          name: "Solo widget",
          notes: null,
          status: "PENDING",
          product: { id: "p-solo", name: "Solo widget", unit: "box", unitsPerBox: 1 },
        } as any,
      ],
    };
    const { draft } = hydrateFromOrder(order);
    expect(Object.keys(draft)).toEqual(["Lsolo"]);
    const originals = orderOriginals(order);
    expect(stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, originals)).toEqual([]);
  });
});

describe("edit-items-draft: resolveDraftKeyForPick / newDraftKey (B775 fleet-lead review, rules 1+2)", () => {
  const productA = "shared-product";

  it("no existing line for the product -> a fresh new: key, never the bare productId", () => {
    const key = resolveDraftKeyForPick({}, productA, null);
    expect(key.startsWith("new:")).toBe(true);
    expect(key).not.toBe(productA);
  });

  it("exactly one non-unit match -> merges into that line's OWN key", () => {
    const draft: Record<string, DraftItem> = {
      La: { productId: productA, qty: 1, unitPrice: 10, catalogPrice: 10, name: "Widget" } as any,
    };
    expect(resolveDraftKeyForPick(draft, productA, null)).toBe("La");
  });

  it("a unit-aware line (unitLabel set) for the same product is NEVER matched by a base/boxed scan", () => {
    const draft: Record<string, DraftItem> = {
      La: {
        productId: productA,
        qty: 12,
        unitPrice: 80,
        catalogPrice: 80,
        name: "Widget",
        unitLabel: "Case",
      } as any,
    };
    const key = resolveDraftKeyForPick(draft, productA, null);
    expect(key).not.toBe("La");
    expect(key.startsWith("new:")).toBe(true);
  });

  it("two legacy non-unit lines for the same product (pre-fix data, or written outside this screen): merges into the FIRST in display order, never touches the second, never creates a third", () => {
    const draft: Record<string, DraftItem> = {
      La: { productId: productA, qty: 1, unitPrice: 10, catalogPrice: 10, name: "Widget" } as any,
      Lb: { productId: productA, qty: 3, unitPrice: 10, catalogPrice: 10, name: "Widget" } as any,
    };
    expect(resolveDraftKeyForPick(draft, productA, null)).toBe("La");
  });

  it("two NEW same-product rows (e.g. one per unit) each get a distinct key — never collide, both survive as CREATEs", () => {
    const k1 = newDraftKey();
    const k2 = newDraftKey();
    expect(k1).not.toBe(k2);
    const draft: Record<string, DraftItem> = {
      [k1]: { productId: productA, qty: 1, unitPrice: 80, catalogPrice: 80, name: "Widget" } as any,
      [k2]: {
        productId: productA,
        qty: 3,
        unitPrice: 12,
        catalogPrice: 12,
        name: "Widget",
      } as any,
    };
    const originals = orderOriginals({ id: "o1", lineItems: [] });
    const items = stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, originals);
    expect(items.filter((i: any) => !i.id)).toHaveLength(2); // both are CREATEs (no lineId)
  });
});

/**
 * B775 review item 1 (SA-103): a source-level regression guard — the draft
 * record (and every render/handler key derived from it) must never again be
 * keyed by productId. Scoped to `(draft|next|d)[...]` bracket access, which
 * is how this file names the draft record everywhere it appears — a
 * function-argument use like `canEditPriceFor(it.productId)` or an unrelated
 * map like `priceHistory?.[p.id]` is not a draft-record access and is not
 * what this pin is about.
 */
describe("edit-items.tsx source pin: the draft record is never keyed by productId (B775)", () => {
  it("no (draft|next|d)[...productId] or (draft|next|d)[p.id] bracket access anywhere in the route file", () => {
    const source = readFileSync(
      join(__dirname, "../app/(operator)/(tabs)/orders/[id]/edit-items.tsx"),
      "utf8",
    );
    const offenders = source.match(
      /\b(?:draft|next|d)\[[^\]]*\.productId\]|\b(?:draft|next|d)\[p\.id\]/g,
    );
    expect(offenders).toBeNull();
  });
});
