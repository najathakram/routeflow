import {
  buildAtDoorChangeRequests,
  dropHandedOffAdded,
  dropHandedOffQty,
  dropSucceededAddedLine,
  leftoverAddedMessage,
} from "../lib/at-door-diff";

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

  // Opus review round 1 on #1302: a driver can re-scan product X while X's
  // ADD_ITEM is still in flight, growing the local draft's qty. Dropping the
  // WHOLE draft by productId on that entry's success would silently lose the
  // extra units the re-scan added (an under-bill) -- subtract only what was
  // actually sent, and keep whatever landed on top of it mid-flight.
  it("subtracts the sent qty instead of dropping the whole draft when a concurrent re-scan grew it", () => {
    // Sent while qty was 2; a 3rd scan landed mid-flight, growing the draft to 3.
    const inFlight = [{ productId: "p-1", qty: 3 }];
    expect(
      dropSucceededAddedLine(inFlight, { type: "ADD_ITEM", productId: "p-1", qty: 2 }),
    ).toEqual([{ productId: "p-1", qty: 1 }]);
  });

  it("subtracts boxes/pieces alongside qty for a boxed product's concurrent re-scan", () => {
    // Sent as 1 case (qty 12) while a 2nd scan landed mid-flight (draft now 2 cases, qty 24).
    const inFlight = [{ productId: "p-2", qty: 24, boxes: 2, pieces: 0 }];
    expect(
      dropSucceededAddedLine(inFlight, {
        type: "ADD_ITEM",
        productId: "p-2",
        qty: 12,
        boxes: 1,
        pieces: 0,
      }),
    ).toEqual([{ productId: "p-2", qty: 12, boxes: 1, pieces: 0 }]);
  });

  it("still drops entirely when the sent qty exactly covers the draft (no concurrent growth)", () => {
    expect(
      dropSucceededAddedLine([{ productId: "p-2", qty: 26, boxes: 2, pieces: 2 }], {
        type: "ADD_ITEM",
        productId: "p-2",
        qty: 26,
        boxes: 2,
        pieces: 2,
      }),
    ).toEqual([]);
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

// Opus review round 2 on #1302 (fleet lead relay): a successful batch called
// router.back() unconditionally, discarding any units a concurrent re-scan
// left in `added` mid-flight -- an under-bill in the common case, not an edge
// case. The batch runner must never silently navigate away with leftovers.
describe("leftoverAddedMessage", () => {
  it("is null when nothing is left to send", () => {
    expect(leftoverAddedMessage([])).toBeNull();
  });

  it("names a single leftover item", () => {
    expect(leftoverAddedMessage([{ productId: "p-1", qty: 1 }])).toBe(
      "1 item still to send — tap Save again.",
    );
  });

  it("names multiple leftover items with plural wording", () => {
    expect(
      leftoverAddedMessage([
        { productId: "p-1", qty: 1 },
        { productId: "p-2", qty: 1 },
      ]),
    ).toBe("2 items still to send — tap Save again.");
  });
});

/**
 * Row 510: an entry the API refused with the driver's restricted block stays a PENDING change request for the office.
 * Its local edit is dropped, or a bare re-tap of "Save changes" would file a SECOND request for the same edit.
 */
describe("handing a restricted entry to the office", () => {
  it("an ADD_ITEM draft is reconciled like a sent one (subtracts what was sent, drops it when nothing remains)", () => {
    const added = [{ productId: "p-1", qty: 3 }];
    expect(dropHandedOffAdded(added, { type: "ADD_ITEM", productId: "p-1", qty: 3 })).toEqual([]);
    expect(dropHandedOffAdded(added, { type: "ADD_ITEM", productId: "p-1", qty: 1 })).toEqual([
      { productId: "p-1", qty: 2 },
    ]);
  });

  it("a CHANGE_QTY or REMOVE_ITEM edit is dropped from the stepper state, leaving other lines alone", () => {
    const qtyById = { "li-1": 8, "li-2": 0 };
    expect(dropHandedOffQty(qtyById, { type: "CHANGE_QTY", orderItemId: "li-1", qty: 8 })).toEqual({
      "li-2": 0,
    });
    expect(dropHandedOffQty(qtyById, { type: "REMOVE_ITEM", orderItemId: "li-2" })).toEqual({
      "li-1": 8,
    });
    expect(qtyById).toEqual({ "li-1": 8, "li-2": 0 }); // never mutated
  });

  it("is a no-op returning the SAME object for an ADD_ITEM entry or a line with no edit", () => {
    const qtyById = { "li-1": 8 };
    expect(dropHandedOffQty(qtyById, { type: "ADD_ITEM", productId: "p-1", qty: 1 })).toBe(qtyById);
    expect(dropHandedOffQty(qtyById, { type: "CHANGE_QTY", orderItemId: "li-9", qty: 2 })).toBe(
      qtyById,
    );
  });

  it("the diff rebuilt after the hand-off holds no entry for the handed-off line", () => {
    const originals = [{ id: "li-1", qty: 10, status: "PENDING" }];
    const entry = { type: "CHANGE_QTY" as const, orderItemId: "li-1", qty: 12 };
    const before = buildAtDoorChangeRequests({
      originals,
      edited: [{ lineId: "li-1", qty: 12 }],
      added: [],
    });
    expect(before).toEqual([entry]);
    const after = dropHandedOffQty({ "li-1": 12 }, entry);
    const rebuilt = buildAtDoorChangeRequests({
      originals,
      edited: Object.entries(after).map(([lineId, qty]) => ({ lineId, qty })),
      added: [],
    });
    expect(rebuilt).toEqual([]); // a bare re-tap files nothing for it
  });
});
