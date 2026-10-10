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
  applyBoxEdit,
  applyPieceEdit,
  applyPickToDraft,
  deserializeEditItemsSnapshot,
  draftTrayRows,
  editItemsSnapshotKey,
  EDIT_ITEMS_SNAPSHOT_VERSION,
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
import { readEditItemsSurface } from "./support/edit-items-source";

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

  it("SA-085h LOW: normalizes a unit line an OLD on-device snapshot saved un-normalized (qty 480, boxes 2 -> count 2)", () => {
    // A snapshot written by a build from before hydrateFromOrder normalized qty to the
    // COUNT — exactly the server's own pack-piece storage shape for a 2-Case line.
    const staleRaw = JSON.stringify({
      v: EDIT_ITEMS_SNAPSHOT_VERSION,
      orderId: "o1",
      savedAt: 1_700_000_000_000,
      baseline: "b",
      orderUpdatedAt: null,
      draft: {
        p1: {
          productId: "p1",
          qty: 480,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 240,
          unitLabel: "Case",
          unitPrice: 220,
          catalogPrice: 24,
          name: "Case widget",
          boxSplit: true,
        },
      },
      unlisted: [],
      pendingDeletes: [],
      selectedCreditIds: [],
      creditsTouched: false,
      floorAcked: [],
    });
    const back = deserializeEditItemsSnapshot(staleRaw);
    expect(back?.draft.p1.qty).toBe(2);
    expect(back?.draft.p1.boxes).toBeUndefined();
    expect(back?.draft.p1.pieces).toBeUndefined();
    expect(back?.draft.p1.boxSplit).toBe(false);
    expect(back?.draft.p1.unitLabel).toBe("Case");
  });

  it("SA-085h LOW: an already-normalized unit line (boxes unset) round-trips untouched", () => {
    const raw = JSON.stringify({
      v: EDIT_ITEMS_SNAPSHOT_VERSION,
      orderId: "o1",
      savedAt: 1_700_000_000_000,
      baseline: "b",
      orderUpdatedAt: null,
      draft: {
        p1: {
          productId: "p1",
          qty: 2,
          unitsPerBox: 240,
          unitLabel: "Case",
          unitPrice: 220,
          catalogPrice: 24,
          name: "Case widget",
        },
      },
      unlisted: [],
      pendingDeletes: [],
      selectedCreditIds: [],
      creditsTouched: false,
      floorAcked: [],
    });
    expect(deserializeEditItemsSnapshot(raw)?.draft.p1.qty).toBe(2);
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

  it("REG-EDIT-DRAFT-B / B775: a well-formed v1 snapshot (pre-fix, productId-keyed draft) is discarded, never restored", () => {
    // A real snapshot a pre-fix build could have written: otherwise
    // well-formed, but `v: 1` and `draft` keyed by productId (the exact
    // shape SA-108's version bump exists to keep off the device).
    const v1 = JSON.stringify({
      v: 1,
      orderId: "o1",
      savedAt: Date.now(),
      baseline: "",
      draft: { "shared-product": { productId: "shared-product", qty: 1, unitPrice: 1 } },
      unlisted: [],
      pendingDeletes: [],
      selectedCreditIds: [],
      creditsTouched: false,
      floorAcked: [],
    });
    expect(deserializeEditItemsSnapshot(v1)).toBeNull();

    // Not a blanket rejection of the shape — only the stale version number:
    // the identical payload at the CURRENT version round-trips (covered
    // above by "serialize -> deserialize round-trips every staged field").
    const current = JSON.parse(v1);
    current.v = EDIT_ITEMS_SNAPSHOT_VERSION;
    expect(deserializeEditItemsSnapshot(JSON.stringify(current))).not.toBeNull();
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
  it("B707a / SA-085f #4: a unit line (boxes 3, snapshot 288, 'Case') hydrates unitsPerBox/unitLabel from ITS OWN line, and normalizes qty to the COUNT (boxes/pieces dropped) — untouched, no UPDATE", () => {
    const order: BaselineOrderLike = {
      id: "o1",
      lineItems: [
        {
          id: "L1",
          productId: "p1",
          qty: 864, // server's pack-piece storage: 3 cases x 288 = 864
          boxes: 3, // the COUNT — unit-line-build.ts stores it here for a unit line
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
    // B775/SA-108: keyed by the line's own id (L1), never productId (p1).
    expect(draft.L1.unitsPerBox).toBe(288);
    expect(draft.L1.unitLabel).toBe("Case");
    // SA-085f MEDIUM #4: qty is normalized to the COUNT (3) — never the raw piece-expanded 864 —
    // and boxes/pieces are dropped, matching what setUnitLabel produces for a freshly-picked
    // line. The "Qty (Case) N" stepper reads `item.qty` directly; this is what makes it 3, not 480.
    expect(draft.L1.qty).toBe(3);
    expect(draft.L1.boxes).toBeUndefined();
    expect(draft.L1.pieces).toBeUndefined();
    expect(draft.L1.boxSplit).toBe(false);

    const originals = orderOriginals(order);
    expect(stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, originals)).toEqual([]);
  });

  it("B707b: incrementing the same unit line's count 3 -> 4 sends {id, qty:4, unitLabel}, never the piece-expanded 1152", () => {
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
    // The stepper's own step (stepLineQty's unit branch): +1 on the normalized count.
    // B775/SA-108: keyed by L1 (the line's own id), never p1 (productId).
    const edited = { ...draft, L1: { ...draft.L1, qty: draft.L1.qty + 1 } };
    const originals = orderOriginals(order);

    // productId rides along with unitLabel (mobile unit picker, order-item-diff.ts) so the
    // server's prepareUnitEditContext preloads the product/ladder for this item.
    expect(stagedDiffItems({ draft: edited, unlisted: [], pendingDeletes: [] }, originals)).toEqual(
      [{ id: "L1", action: "UPDATE", qty: 4, unitLabel: "Case", productId: "p1" }],
    );
  });

  it("units_v1: a brand-new unit-sold draft line (picker, no lineId) maps basePrice off the unit's OWN price, never the pack's catalogPrice", () => {
    // Same defect shape as B465 on #1252: without unitPriceBase, stagedDiffItems fed
    // buildOrderItemDiff a basePrice of 24 (the Box's catalogPrice) against a Case unitPrice of
    // 220 — an untouched picker selection would misclassify as a $196 manual override and send
    // an unwanted unitPrice/overrideReason on a line nobody typed a price into.
    const draft: Record<string, DraftItem> = {
      p9: {
        productId: "p9",
        qty: 3, // the unit COUNT
        unitsPerBox: null,
        unitPrice: 220, // set by setUnitLabel to the picked option's own resolved price
        unitBasePrice: 220, // set alongside it — untouched, so basePrice must equal unitPrice
        catalogPrice: 24, // the PACK's price — must NOT be used as the comparison base
        unitLabel: "Case",
        name: "Case widget",
        // no lineId: this line was added THIS session via the picker
      },
    };
    expect(stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, [])).toEqual([
      { productId: "p9", qty: 3, unitLabel: "Case" },
    ]);
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
    // SA-085f MEDIUM #4: La is a unit-labeled (Case) line, so qty is normalized to
    // the COUNT (1 case) — never the raw piece-expanded 288 (boxes:1 x unitsPerBox:288).
    expect(draft.La.qty).toBe(1);
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

  it("Opus round: TWO PLAIN (non-unit) same-product lines — not just Case+pack — also no-op on a zero-edit save", () => {
    // Broader than the Case+pack repro fixture: two ordinary loose lines for
    // the same product, neither unit-aware, pre-dating units_v1 or written by
    // a path that never dedupes on productId (create()'s dto.items mapping).
    const order: BaselineOrderLike = {
      id: "o1",
      lineItems: [
        {
          id: "Lc",
          productId: "shared-product-2",
          qty: 4,
          unitPrice: 9,
          name: "Widget (plain)",
          notes: null,
          status: "PENDING",
        } as any,
        {
          id: "Ld",
          productId: "shared-product-2",
          qty: 6,
          unitPrice: 9,
          name: "Widget (plain)",
          notes: null,
          status: "PENDING",
        } as any,
      ],
    };
    const { draft } = hydrateFromOrder(order);
    expect(Object.keys(draft).sort()).toEqual(["Lc", "Ld"]);
    const originals = orderOriginals(order);
    const items = stagedDiffItems({ draft, unlisted: [], pendingDeletes: [] }, originals);
    expect(items).toEqual([]);
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

  it("SA-108: resolveDraftKeyForPick's result is NOT the item's own lineId-or-productId — the exact miss the old fallback made", () => {
    // The banned formula was `it.lineId ?? it.productId`. A stored item whose
    // OWN lineId/productId happens to equal "La" must not fool the resolver
    // into a false match when the draft's actual storage key differs — proof
    // the resolver reads the RECORD KEY, never re-derives one from fields.
    const stored: DraftItem = {
      productId: productA,
      lineId: "La",
      qty: 1,
      unitPrice: 10,
      catalogPrice: 10,
      name: "Widget",
    } as any;
    const draft: Record<string, DraftItem> = { "storage-key-9": stored };
    const bannedFormula = stored.lineId ?? stored.productId;
    expect(resolveDraftKeyForPick(draft, productA, null)).not.toBe(bannedFormula);
    expect(resolveDraftKeyForPick(draft, productA, null)).toBe("storage-key-9");

    // And for a fresh add with NO existing line, the banned formula would
    // resolve to the bare productId — the resolver must never do that either.
    expect(resolveDraftKeyForPick({}, productA, null)).not.toBe(productA);
  });

  it("a scan that merges into an existing line produces exactly ONE UPDATE carrying that line's real id — never a stray CREATE", () => {
    const order: BaselineOrderLike = {
      id: "o1",
      lineItems: [
        {
          id: "La",
          productId: productA,
          qty: 1,
          unitPrice: 10,
          name: "Widget",
          notes: null,
          status: "PENDING",
        } as any,
      ],
    };
    const { draft } = hydrateFromOrder(order);
    const key = resolveDraftKeyForPick(draft, productA, null);
    expect(key).toBe("La"); // resolves to the hydrated line's OWN key, not a new: key
    const merged = { ...draft, [key]: { ...draft[key], qty: draft[key].qty + 1 } };
    const originals = orderOriginals(order);
    const items = stagedDiffItems({ draft: merged, unlisted: [], pendingDeletes: [] }, originals);
    expect(items).toEqual([{ id: "La", action: "UPDATE", qty: 2 }]);
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
 * B775 review item 1 (SA-103 + SA-108 Opus round): a source-level regression
 * guard — the draft record (and every render/handler key derived from it)
 * must never again be keyed by productId, and never re-derived from an
 * item's own fields (the exact SA-108 regression: `it.lineId ?? it.productId`
 * silently resolves wrong for a fresh add that has no `lineId` yet). Three
 * shapes are scoped in:
 *   1. `(draft|next|d)[...]` bracket ACCESS keyed by productId.
 *   2. A computed object-literal KEY built from productId (`{[x.productId]:
 *      ...}` / `{[p.id]: ...}`) — the shape the old `priceEditItem` re-keying
 *      used before it became `{ key, item }`.
 *   3. Any `lineId ?? ` fallback text at all, which is the SA-108 root cause.
 * All three are matched against comment-stripped source — a function-argument
 * use like `canEditPriceFor(it.productId)`, an unrelated map like
 * `priceHistory?.[p.id]`, and this file's own explanatory prose (which
 * necessarily discusses the banned pattern) must never satisfy or defeat this
 * pin either way.
 */
describe("edit-items.tsx source pin: the draft record is never keyed by productId (B775)", () => {
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const source = stripComments(readEditItemsSurface());
  // B805: draft/draftRef/updateDraft moved to a shared hook (size-ratchet
  // driven) — pins about THEIR implementation now read this file instead.
  const hookSource = stripComments(
    readFileSync(join(__dirname, "../hooks/useEditItemsDraft.ts"), "utf8"),
  );
  // size-ratchet extraction moved resolveDraftKeyForPick's own call site into
  // resolvePickTarget (lib/edit-items-draft.ts) — some pins below check there instead.
  const libSource = stripComments(
    readFileSync(join(__dirname, "../lib/edit-items-draft.ts"), "utf8"),
  );

  it("no (draft|next|d)[...productId] or (draft|next|d)[p.id] bracket access anywhere in the route file", () => {
    const offenders = source.match(
      /\b(?:draft|next|d)\[[^\]]*\.productId\]|\b(?:draft|next|d)\[p\.id\]/g,
    );
    expect(offenders).toBeNull();
  });

  it("no computed object-literal key built from productId ({[x.productId]: ...} / {[p.id]: ...})", () => {
    const offenders = source.match(/\[[^\]]*\.productId\]\s*:|\[p\.id\]\s*:/g);
    expect(offenders).toBeNull();
  });

  it("no `lineId ?? ` fallback anywhere — the exact SA-108 regression (a fresh add has no lineId yet)", () => {
    expect(source).not.toContain("lineId ?? ");
  });

  it("the render loop reads the draft's key from Object.entries, never derives one", () => {
    expect(source).toMatch(/Object\.entries\(draft\)/);
  });

  it("SA-108d pin 4: resolvePickTarget's ONLY call form reads draftRef.current, never `draft` and never any updater's own `d`", () => {
    // All three banned forms: `resolvePickTarget(draft, ...)` (the render-time
    // closure — stale across a same-tick burst); `(d, ...)` (an updater's own
    // param — SA-108a's regression, correct only when React happens to run
    // THAT updater eagerly, which it does not reliably for ANY call, first or
    // later, once the alternate fiber carries stale lanes — SA-108d/E44); and
    // a bare `apply(draftRef...` typo-shaped call would still need the
    // literal call form below. resolvePickTarget itself (lib/edit-items-draft.ts,
    // size-ratchet extraction) then feeds that same value straight into
    // resolveDraftKeyForPick as its own `draft` param — never re-closed-over.
    expect(source).not.toMatch(/resolvePickTarget\(draft,/);
    expect(source).not.toMatch(/resolvePickTarget\(d,/);
    expect(source).toMatch(/resolvePickTarget\(draftRef\.current,/);
    expect(libSource).toMatch(/resolveDraftKeyForPick\(draft,/);
  });

  it("SA-108d pin 3: draftRef is assigned in the render body (the per-render mirror) — now inside useEditItemsDraft", () => {
    expect(hookSource).toMatch(/draftRef\.current = draft;/);
  });

  it("SA-108d pin 2: updateDraft's OWN body (useEditItemsDraft) is draftRef.current = fn(draftRef.current) immediately followed by setDraft(fn) — the ref-first shape lives in ONE place", () => {
    // B805: every writer funnels through updateDraft, so the ref-first
    // pattern only needs to be correct ONCE, in the hook, rather than
    // re-proven at each of the ~12 call sites in the screen. fn is a PURE
    // function of `d` alone; running it once, synchronously, ourselves —
    // right before handing the SAME function to setDraft — is what makes
    // the ref trustworthy regardless of whether/when React actually
    // invokes it.
    const updateDraftStart = hookSource.indexOf("const updateDraft = (fn:");
    expect(updateDraftStart).toBeGreaterThan(-1);
    const body = hookSource.slice(updateDraftStart, updateDraftStart + 300);
    expect(body).toMatch(/draftRef\.current = fn\(draftRef\.current\);\s*\n\s*setDraft\(fn\);/);
  });

  it("SA-108a's resolvedKeyRef is gone entirely — superseded by the ref-first apply() shape", () => {
    expect(source).not.toMatch(/resolvedKeyRef/);
  });

  it("B805: no `draftRef.current =` assignment exists inside ANY updateDraft(fn) call's fn body — that write belongs to updateDraft alone", () => {
    // The exact SA-108a mistake, generalized: a ref write is only reliable
    // at a call site WE control (updateDraft's own body), never inside a
    // callback React decides when, or whether more than once, to invoke.
    // Scoped to updateDraft CALL SITES specifically (the arrow function
    // passed as `fn`), not updateDraft's own definition just pinned above.
    const callSites = [...source.matchAll(/updateDraft\(\((?:d|_d)\) => [\s\S]{0,20}?\{/g)];
    expect(callSites.length).toBeGreaterThan(0);
    for (const m of callSites) {
      const start = m.index! + m[0].length;
      // Bound the scan to the next top-level `};` a couple hundred chars out
      // — every one of these fn bodies is short; this is generous enough to
      // never truncate one while staying well clear of the NEXT call site.
      const body = source.slice(start, start + 800);
      expect(body).not.toMatch(/draftRef\.current\s*=/);
    }
  });

  it("B805: every per-line draft writer in the screen calls updateDraft(, never setDraft( directly — setDraft appears only for the three whole-draft lifecycle replacements (hydrate/restore/post-save rebuild); updateDraft's own setDraft(fn) now lives in the hook", () => {
    // Scoped to EditOrderItemsScreen's own body (+ DraftItemCard, which follows it). StepperRow,
    // which declares its OWN local `const [draft, setDraft] = useState(...)` for a text-input
    // string (a pure naming collision), now lives in components/EditItemsStepperRow.tsx (#2232
    // prefactor), so the region ends at the next component, PriceOverrideModal — the same span.
    const screenStart = source.indexOf("export function EditOrderItemsScreen(");
    expect(screenStart).toBeGreaterThan(-1);
    const stepperRowStart = source.indexOf("function PriceOverrideModal(", screenStart);
    expect(stepperRowStart).toBeGreaterThan(screenStart);
    const screenSrc = source.slice(screenStart, stepperRowStart);
    const setDraftCalls = [...screenSrc.matchAll(/\bsetDraft\(/g)];
    // hydrateFromOrder's `setDraft(next);` + the snapshot-restore
    // `setDraft(restored.draft);` + the post-save rebuild
    // `setDraft(rebuilt.draft);` — exactly 3, all VALUE dispatch at a
    // lifecycle boundary, never an inline arrow-function updater doing a
    // per-line edit (that would mean a writer bypassed updateDraft).
    expect(setDraftCalls.length).toBe(3);
    expect(screenSrc).toMatch(/setDraft\(next\);/);
    expect(screenSrc).toMatch(/setDraft\(restored\.draft\);/);
    expect(screenSrc).toMatch(/setDraft\(rebuilt\.draft\);/);
  });

  it("B805: useEditItemsDraft's own setDraft(fn) call exists exactly once, and the hook returns draft/setDraft/draftRef/updateDraft for the screen's three lifecycle sites plus every per-line writer", () => {
    expect([...hookSource.matchAll(/\bsetDraft\(/g)].length).toBe(1);
    expect(hookSource).toMatch(/setDraft\(fn\);/);
    expect(hookSource).toMatch(/return \{ draft, setDraft, draftRef, updateDraft \};/);
  });
});

describe("edit-items-draft: applyPickToDraft (SA-108d pin 1 — the transform lives in lib, pure)", () => {
  const productA = "shared-product";
  const boxedInput = {
    productId: productA,
    unitsPerBox: 12,
    startPrice: 24,
    catalogPrice: 24,
    name: "Boxed widget",
    unit: "box",
    level: "BOX" as const,
  };

  it("a fresh add (boxed) starts at 1 box, unitPrice = startPrice", () => {
    const next = applyPickToDraft({}, "new:1", boxedInput);
    expect(next["new:1"]).toMatchObject({
      productId: productA,
      qty: 12,
      boxes: 1,
      pieces: 0,
      boxSplit: true,
      unitPrice: 24,
    });
  });

  it("merging into an existing line increments by one box, preserving every other field (a price override survives)", () => {
    const draft: Record<string, DraftItem> = {
      L1: { ...boxedInput, qty: 12, boxes: 1, pieces: 0, unitPrice: 20, overrideReason: "deal" },
    };
    const next = applyPickToDraft(draft, "L1", boxedInput);
    expect(next.L1).toMatchObject({ qty: 24, boxes: 2, pieces: 0, unitPrice: 20 });
    expect(next.L1!.overrideReason).toBe("deal");
  });

  it("is a PURE function: the same (draft, key, input) always produces a deep-equal result, and never mutates its input draft", () => {
    const draft: Record<string, DraftItem> = { L1: { ...boxedInput, qty: 12 } as any };
    const snapshot = JSON.parse(JSON.stringify(draft));
    const a = applyPickToDraft(draft, "L1", boxedInput);
    const b = applyPickToDraft(draft, "L1", boxedInput);
    expect(a).toEqual(b);
    expect(draft).toEqual(snapshot); // input draft untouched
  });

  it("SA-108d pin 1: applied TWICE to an empty draft with the key minted per call the way the screen does — via resolveDraftKeyForPick against a ref updated synchronously after each apply — merges into ONE row at qty 2 (boxes 2), never two rows", () => {
    // Mirrors exactly what addPickedToDraft now does: mint the key from the
    // ref BEFORE building `apply`, then update the ref synchronously with
    // apply's own result — simulating two same-tick picks of the SAME
    // product where React has not (and, per SA-108d, may never reliably)
    // run either setDraft updater yet.
    let draftRef: Record<string, DraftItem> = {};
    const pickOnce = () => {
      const key = resolveDraftKeyForPick(draftRef, productA, null);
      draftRef = applyPickToDraft(draftRef, key, boxedInput);
      return key;
    };
    const key1 = pickOnce();
    const key2 = pickOnce();
    expect(key2).toBe(key1); // merged into the SAME row, never a second `new:` key
    expect(Object.keys(draftRef)).toEqual([key1]);
    expect(draftRef[key1]).toMatchObject({ qty: 24, boxes: 2, pieces: 0 });
  });
});

/**
 * SA-085i(c): a NON-unit line's Cases/Loose edit must match master's OLD inline rule
 * byte-for-byte — the typed count REPLACES qty; a legacy line's plain (un-split) qty is
 * NEVER reinterpreted as loose pieces. The shared sale-line.ts fold (splitFromPrev, correct
 * for the CREATE screen's own in-session cart accumulation) would read a no-split qty as
 * pieces, inventing phantom loose units the first time this screen's own steppers touch a
 * STORED historical line — a real regression the earlier round's setLineBoxes/setLinePieces
 * routing introduced. Not fixed by that route in THIS PR (a separate, pre-existing fold bug
 * would need its own fix); applyBoxEdit/applyPieceEdit simply never take it.
 */
describe("applyBoxEdit / applyPieceEdit (SA-085i(c))", () => {
  it("a legacy line (qty 3, boxes null, upb 12) edited via Cases to 4 gives 4 boxes, 0 pieces, qty 48 — NEVER 3 phantom loose pieces", () => {
    const legacy: DraftItem = {
      productId: "p1",
      qty: 3,
      unitsPerBox: 12,
      unitPrice: 5,
      catalogPrice: 5,
      name: "Legacy widget",
    };
    const result = applyBoxEdit(legacy, 4, 12);
    expect(result.boxes).toBe(4);
    expect(result.pieces).toBe(0);
    expect(result.qty).toBe(48);
    // The shipped-bug reconstruction: the shared fold would read qty:3 as 3 loose pieces
    // first, giving {boxes:4, pieces:3, qty:51} instead.
    expect(result.qty).not.toBe(51);
    expect(result.pieces).not.toBe(3);
  });

  it("a legacy line's Loose edit is equally unaffected by its own un-split qty", () => {
    const legacy: DraftItem = {
      productId: "p1",
      qty: 3,
      unitsPerBox: 12,
      unitPrice: 5,
      catalogPrice: 5,
      name: "Legacy widget",
    };
    const result = applyPieceEdit(legacy, 5, 12);
    expect(result.boxes).toBe(0); // cur.boxes ?? 0 — nothing folded in from the plain qty
    expect(result.pieces).toBe(5);
    expect(result.qty).toBe(5);
  });

  it("a unit-sold line refuses the split outright, returning it unchanged", () => {
    const unitLine: DraftItem = {
      productId: "p1",
      qty: 2,
      unitsPerBox: 240,
      unitLabel: "Case",
      unitPrice: 220,
      catalogPrice: 24,
      name: "Case widget",
    };
    expect(applyBoxEdit(unitLine, 5, 240)).toEqual(unitLine);
    expect(applyPieceEdit(unitLine, 5, 240)).toEqual(unitLine);
  });

  it("preserves an ALREADY-split line's other pieces/boxes exactly like master's old rule", () => {
    const split: DraftItem = {
      productId: "p1",
      qty: 27,
      boxes: 2,
      pieces: 3,
      unitsPerBox: 12,
      unitPrice: 5,
      catalogPrice: 5,
      name: "Split widget",
    };
    // Setting boxes to 4 keeps the existing 3 loose pieces (master's rule: pcs = cur.pieces).
    expect(applyBoxEdit(split, 4, 12)).toMatchObject({ boxes: 4, pieces: 3, qty: 51 });
    // Setting pieces to 5 keeps the existing 2 boxes.
    expect(applyPieceEdit(split, 5, 12)).toMatchObject({ boxes: 2, pieces: 5, qty: 29 });
  });
});
