import { buildAtDoorChangeRequests } from "../lib/at-door-diff";

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
