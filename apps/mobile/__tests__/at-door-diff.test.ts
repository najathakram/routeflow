import { buildAtDoorChangeRequests, dropSucceededAddedLine } from "../lib/at-door-diff";

describe("buildAtDoorChangeRequests", () => {
  const originals = [
    { id: "li-1", qty: 10, status: "PENDING" },
    { id: "li-2", qty: 5, status: "PENDING" },
    { id: "li-3", qty: 4, status: "PENDING", deliveredQty: 4 }, // already delivered
    { id: "li-4", qty: 2, status: "CANCELLED" },
  ];

  it("emits CHANGE_QTY only for lines whose qty actually changed", () => {
    const out = buildAtDoorChangeRequests({
      originals,
      edited: [
        { lineId: "li-1", qty: 8 },
        { lineId: "li-2", qty: 5 },
      ], // li-2 unchanged
      added: [],
    });
    expect(out).toEqual([{ type: "CHANGE_QTY", orderItemId: "li-1", qty: 8 }]);
  });

  it("emits REMOVE_ITEM when qty is zeroed", () => {
    const out = buildAtDoorChangeRequests({
      originals,
      edited: [{ lineId: "li-1", qty: 0 }],
      added: [],
    });
    expect(out).toEqual([{ type: "REMOVE_ITEM", orderItemId: "li-1" }]);
  });

  it("never touches already-delivered or cancelled lines even if present in edited", () => {
    const out = buildAtDoorChangeRequests({
      originals,
      edited: [
        { lineId: "li-3", qty: 1 },
        { lineId: "li-4", qty: 1 },
      ],
      added: [],
    });
    expect(out).toEqual([]);
  });

  it("emits ADD_ITEM for scanned products, boxes/pieces only when present", () => {
    const out = buildAtDoorChangeRequests({
      originals: [],
      edited: [],
      added: [
        { productId: "p-1", qty: 3 },
        { productId: "p-2", qty: 26, boxes: 2, pieces: 2 },
      ],
    });
    expect(out).toEqual([
      { type: "ADD_ITEM", productId: "p-1", qty: 3 },
      { type: "ADD_ITEM", productId: "p-2", qty: 26, boxes: 2, pieces: 2 },
    ]);
  });

  it("returns [] for a no-op diff", () => {
    expect(buildAtDoorChangeRequests({ originals, edited: [], added: [] })).toEqual([]);
  });
});

// ─── B795: a succeeded ADD_ITEM must never be resent on a re-Save ───────────
// The at-door batch runner is resumable but a bare re-tap of "Save changes"
// rebuilds a FRESH diff from the local `added` state at index 0. Unlike
// CHANGE_QTY/REMOVE_ITEM (self-healing: the diff is built against a freshly
// refetched order, so an already-applied edit no-ops), a scanned product has
// no such signal in `order.lineItems` — so a succeeded ADD_ITEM left in
// `added` gets re-diffed and double-adds the line server-side.

describe("dropSucceededAddedLine", () => {
  const added = [
    { productId: "p-1", qty: 3 },
    { productId: "p-2", qty: 26, boxes: 2, pieces: 2 },
  ];

  it("drops the added draft whose ADD_ITEM entry just succeeded", () => {
    expect(dropSucceededAddedLine(added, { type: "ADD_ITEM", productId: "p-1", qty: 3 })).toEqual([
      { productId: "p-2", qty: 26, boxes: 2, pieces: 2 },
    ]);
  });

  it("leaves `added` untouched for a CHANGE_QTY/REMOVE_ITEM entry (no productId)", () => {
    expect(dropSucceededAddedLine(added, { type: "CHANGE_QTY", orderItemId: "li-1", qty: 8 })).toBe(
      added,
    );
    expect(dropSucceededAddedLine(added, { type: "REMOVE_ITEM", orderItemId: "li-1" })).toBe(added);
  });

  it("no-ops when the entry's productId isn't in `added` (already dropped, or not this batch)", () => {
    expect(dropSucceededAddedLine(added, { type: "ADD_ITEM", productId: "p-3", qty: 1 })).toEqual(
      added,
    );
  });
});

describe("B795: a two-entry added batch whose second entry fails — re-Save sends only the second", () => {
  it("a succeeded first ADD_ITEM is excluded from the rebuilt diff after the second fails", () => {
    const originalAdded = [
      { productId: "p-1", qty: 1 },
      { productId: "p-2", qty: 1 },
    ];
    const diff = buildAtDoorChangeRequests({ originals: [], edited: [], added: originalAdded });
    expect(diff).toEqual([
      { type: "ADD_ITEM", productId: "p-1", qty: 1 },
      { type: "ADD_ITEM", productId: "p-2", qty: 1 },
    ]);

    // processDiff: entry 0 (p-1) succeeds -> dropped from local `added` state.
    const addedAfterFirstSuccess = dropSucceededAddedLine(originalAdded, diff[0]!);
    // entry 1 (p-2) fails (credit block / message-less 409 / offline / license
    // cancel) -> the batch stops; `added` still correctly holds the one that
    // did NOT succeed.
    expect(addedAfterFirstSuccess).toEqual([{ productId: "p-2", qty: 1 }]);

    // Driver re-taps "Save changes": handleSave() refetches and rebuilds the
    // diff fresh from the now-updated `added`.
    const retryDiff = buildAtDoorChangeRequests({
      originals: [],
      edited: [],
      added: addedAfterFirstSuccess,
    });
    expect(retryDiff).toEqual([{ type: "ADD_ITEM", productId: "p-2", qty: 1 }]);
  });
});
