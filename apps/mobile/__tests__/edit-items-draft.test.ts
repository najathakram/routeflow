/**
 * `lib/edit-items-draft.ts` — the pure layer behind the order-item editor.
 *
 * Pure-logic only (mobile Jest is `testEnvironment: "node"`): the dirty check,
 * the Save payload, the on-device snapshot and the drawer's rows. The screen's
 * JSX wiring is pinned separately by `edit-items-drawer.test.ts`.
 */
import { computeLineSubtotal } from "@routeflow/pricing";
import { buildOrderItemDiff } from "../lib/order-item-diff";
import {
  deserializeEditItemsSnapshot,
  draftTrayRows,
  editItemsSnapshotKey,
  hasUnsavedItemEdits,
  hasUnsavedWork,
  isSnapshotStale,
  makeEditItemsSnapshot,
  orderOriginals,
  pickerTrayExpandedHeight,
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
