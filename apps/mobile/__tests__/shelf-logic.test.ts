/**
 * P5-16b: Your Shelf + change-request pure logic. MONEY anchor: buildShelfAddItem
 * MUST split a boxed product's suggested qty into {boxes, pieces:0} — a bare qty on
 * the buyer create path is read as a BOX count (unitsPerBox× over-order/over-charge).
 * The cent-parity assertion below documents both the correct payload and the
 * guarded failure mode (a naive qty*unitPrice) side by side.
 */
import {
  buildShelfAddItem,
  canRequestChange,
  changeRequestChip,
  daysLeftFraction,
  daysLeftLabel,
  describeChangeRequest,
  describeResolution,
  groupShelfEstimates,
  orderCancellable,
  orderEditable,
  qtyLabel,
} from "../lib/shelf-logic";
import { computeLineSubtotal } from "../lib/pricing";
import type { BuyerOrder, ChangeRequest, ShelfEstimate } from "../lib/api/buyer";

function shelfEstimate(overrides: Partial<ShelfEstimate> = {}): ShelfEstimate {
  return {
    productId: "p1",
    name: "Product",
    unit: "ea",
    unitsPerBox: null,
    imageKey: null,
    lastOrderedAt: "2026-01-01",
    orderCount: 3,
    cadenceDays: null,
    daysSinceLast: 5,
    estDaysLeft: null,
    typicalQty: 1,
    suggestedQty: 1,
    state: "ok",
    imageUrl: null,
    snoozed: false,
    snoozedUntil: null,
    ...overrides,
  };
}

function changeRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: "cr1",
    orderId: "o1",
    orderItemId: null,
    productId: null,
    type: "NOTE",
    status: "PENDING",
    payload: {},
    note: null,
    requestedByName: "Buyer",
    requestedByRole: "CUSTOMER",
    resolvedByName: null,
    resolvedByRole: null,
    resolution: null,
    resolutionReason: null,
    nextOrderId: null,
    resolvedAt: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupShelfEstimates", () => {
  it("undefined → all-empty sections", () => {
    expect(groupShelfEstimates(undefined)).toEqual({ low: [], dueSoon: [], snoozed: [], rest: [] });
  });

  it("splits by state into low/dueSoon/rest", () => {
    const low = shelfEstimate({ productId: "low1", state: "low" });
    const dueSoon = shelfEstimate({ productId: "due1", state: "due-soon" });
    const ok = shelfEstimate({ productId: "ok1", state: "ok" });
    const sections = groupShelfEstimates([low, dueSoon, ok]);
    expect(sections.low).toEqual([low]);
    expect(sections.dueSoon).toEqual([dueSoon]);
    expect(sections.rest).toEqual([ok]);
    expect(sections.snoozed).toEqual([]);
  });

  it("snoozed beats state — a snoozed low/due-soon item lands only in snoozed", () => {
    const snoozedLow = shelfEstimate({ productId: "s1", state: "low", snoozed: true });
    const snoozedDue = shelfEstimate({ productId: "s2", state: "due-soon", snoozed: true });
    const sections = groupShelfEstimates([snoozedLow, snoozedDue]);
    expect(sections.snoozed).toEqual([snoozedLow, snoozedDue]);
    expect(sections.low).toEqual([]);
    expect(sections.dueSoon).toEqual([]);
  });
});

describe("buildShelfAddItem — MONEY guard", () => {
  it("boxed, exact multiple: 24 pcs @ 12/box → {qty:24, boxes:2, pieces:0}", () => {
    const item = buildShelfAddItem({ productId: "case", suggestedQty: 24, unitsPerBox: 12 });
    expect(item).toEqual({ productId: "case", qty: 24, boxes: 2, pieces: 0 });
  });

  it("boxed, non-multiple: 20 pcs @ 12/box rounds to 2 boxes (24 pcs, not a fractional box)", () => {
    const item = buildShelfAddItem({ productId: "case", suggestedQty: 20, unitsPerBox: 12 });
    expect(item).toEqual({ productId: "case", qty: 24, boxes: 2, pieces: 0 });
  });

  it("boxed, small suggestion: 6 pcs @ 12/box → at least 1 full box (12 pcs)", () => {
    const item = buildShelfAddItem({ productId: "case", suggestedQty: 6, unitsPerBox: 12 });
    expect(item).toEqual({ productId: "case", qty: 12, boxes: 1, pieces: 0 });
  });

  it("non-boxed product → bare {qty}, no boxes/pieces keys", () => {
    const item = buildShelfAddItem({ productId: "soda", suggestedQty: 6, unitsPerBox: null });
    expect(item).toEqual({ productId: "soda", qty: 6 });
    expect(item).not.toHaveProperty("boxes");
    expect(item).not.toHaveProperty("pieces");
  });

  it("unitsPerBox === 1 is treated as not boxed", () => {
    const item = buildShelfAddItem({ productId: "soda", suggestedQty: 6, unitsPerBox: 1 });
    expect(item).toEqual({ productId: "soda", qty: 6 });
  });

  it("cent-parity: the boxed payload prices identically through computeLineSubtotal — and documents the guarded failure mode", () => {
    const item = buildShelfAddItem({ productId: "case", suggestedQty: 24, unitsPerBox: 12 });
    // Correct: computeLineSubtotal honors the boxes/pieces split (box-priced proration).
    expect(
      computeLineSubtotal({
        unitPrice: 30,
        qty: item.qty,
        boxes: item.boxes,
        pieces: item.pieces,
        unitsPerBox: 12,
      }),
    ).toBe(60);
    // Guarded failure mode: a naive qty*unitPrice (ignoring the box split) would
    // read qty as a BOX count and over-charge unitsPerBox× — documented, not asserted-good.
    expect(item.qty * 30).toBe(720);
  });
});

describe("qtyLabel", () => {
  it("boxed product renders pcs + box count", () => {
    expect(qtyLabel({ suggestedQty: 24, unitsPerBox: 12, unit: "ea" })).toBe(
      "24 pcs (2 boxes of 12)",
    );
  });

  it("boxed product, singular box", () => {
    expect(qtyLabel({ suggestedQty: 6, unitsPerBox: 12, unit: "ea" })).toBe("6 pcs (1 box of 12)");
  });

  it("non-boxed product renders qty + unit", () => {
    expect(qtyLabel({ suggestedQty: 3, unitsPerBox: null, unit: "ea" })).toBe("3 ea");
  });
});

describe("daysLeftFraction", () => {
  it("null when estDaysLeft is missing", () => {
    expect(daysLeftFraction({ estDaysLeft: null, cadenceDays: 7 })).toBeNull();
  });

  it("null when cadenceDays is missing or non-positive", () => {
    expect(daysLeftFraction({ estDaysLeft: 3, cadenceDays: null })).toBeNull();
    expect(daysLeftFraction({ estDaysLeft: 3, cadenceDays: 0 })).toBeNull();
  });

  it("clamps below 0 up to 0 (overdue)", () => {
    expect(daysLeftFraction({ estDaysLeft: -2, cadenceDays: 7 })).toBe(0);
  });

  it("clamps above 1 down to 1", () => {
    expect(daysLeftFraction({ estDaysLeft: 14, cadenceDays: 7 })).toBe(1);
  });

  it("normal fraction in range", () => {
    expect(daysLeftFraction({ estDaysLeft: 3, cadenceDays: 6 })).toBe(0.5);
  });
});

describe("daysLeftLabel", () => {
  it("no pattern yet when estDaysLeft is null", () => {
    expect(daysLeftLabel({ estDaysLeft: null })).toBe("no pattern yet");
  });

  it("overdue label for negative days", () => {
    expect(daysLeftLabel({ estDaysLeft: -3 })).toBe("3d overdue");
  });

  it("due today at exactly 0", () => {
    expect(daysLeftLabel({ estDaysLeft: 0 })).toBe("due today");
  });

  it("days-left label for positive values", () => {
    expect(daysLeftLabel({ estDaysLeft: 5 })).toBe("~5d left");
  });
});

describe("orderEditable / orderCancellable gates", () => {
  it("editable: PENDING/CONFIRMED with an open (or absent) edit window", () => {
    expect(orderEditable({ status: "PENDING", editWindow: undefined })).toBe(true);
    expect(
      orderEditable({
        status: "CONFIRMED",
        editWindow: { editable: true, editableUntil: null, closedReason: null },
      }),
    ).toBe(true);
  });

  it("not editable once the edit window closes", () => {
    expect(
      orderEditable({
        status: "PENDING",
        editWindow: { editable: false, editableUntil: null, closedReason: "DISPATCHED" },
      }),
    ).toBe(false);
  });

  it("not editable for a status outside PENDING/CONFIRMED", () => {
    expect(orderEditable({ status: "OUT_FOR_DELIVERY", editWindow: undefined })).toBe(false);
    expect(orderEditable({ status: "DELIVERED", editWindow: undefined })).toBe(false);
  });

  it("cancellable: PENDING/DRAFT with an open (or absent) edit window", () => {
    expect(orderCancellable({ status: "PENDING", editWindow: undefined })).toBe(true);
    expect(orderCancellable({ status: "DRAFT", editWindow: undefined })).toBe(true);
  });

  it("not cancellable once the edit window closes", () => {
    expect(
      orderCancellable({
        status: "DRAFT",
        editWindow: { editable: false, editableUntil: null, closedReason: "STATUS" },
      }),
    ).toBe(false);
  });

  it("not cancellable for CONFIRMED (editable, but not a cancellable status)", () => {
    expect(orderCancellable({ status: "CONFIRMED", editWindow: undefined })).toBe(false);
  });
});

describe("canRequestChange", () => {
  it("true when the route run is IN_PROGRESS and the order is still deliverable", () => {
    expect(canRequestChange({ status: "PENDING", routeRun: { status: "IN_PROGRESS" } })).toBe(true);
    expect(canRequestChange({ status: "CONFIRMED", routeRun: { status: "IN_PROGRESS" } })).toBe(
      true,
    );
    expect(
      canRequestChange({ status: "OUT_FOR_DELIVERY", routeRun: { status: "IN_PROGRESS" } }),
    ).toBe(true);
  });

  it("false when there is no route run, or it isn't IN_PROGRESS", () => {
    expect(canRequestChange({ status: "PENDING", routeRun: null })).toBe(false);
    expect(canRequestChange({ status: "PENDING", routeRun: { status: "PLANNED" } })).toBe(false);
    expect(canRequestChange({ status: "PENDING", routeRun: undefined })).toBe(false);
  });

  it("false once the order is already delivered/cancelled, even mid-route", () => {
    expect(canRequestChange({ status: "DELIVERED", routeRun: { status: "IN_PROGRESS" } })).toBe(
      false,
    );
    expect(canRequestChange({ status: "CANCELLED", routeRun: { status: "IN_PROGRESS" } })).toBe(
      false,
    );
  });
});

describe("changeRequestChip", () => {
  it("PENDING → orange", () => {
    expect(changeRequestChip("PENDING")).toEqual({ label: "Pending", variant: "orange" });
  });

  it("APPROVED → green", () => {
    expect(changeRequestChip("APPROVED")).toEqual({ label: "Approved", variant: "green" });
  });

  it("DECLINED → red", () => {
    expect(changeRequestChip("DECLINED")).toEqual({ label: "Declined", variant: "red" });
  });
});

describe("describeChangeRequest — NO money on purpose", () => {
  const lineItems = [{ id: "li1", product: { name: "Widget" } }];

  it("ADD_ITEM shows qty + product name + box split, no $ anywhere", () => {
    const cr = changeRequest({
      type: "ADD_ITEM",
      payload: { qty: 24, productName: "Widget", boxes: 2, pieces: 0 },
      note: "please rush",
    });
    const result = describeChangeRequest(cr, lineItems);
    expect(result.title).toBe("Add 24 × Widget (2 boxes)");
    expect(result.detail).toBe("please rush");
    expect(result.title).not.toContain("$");
  });

  it("ADD_ITEM with leftover pieces appends the piece count", () => {
    const cr = changeRequest({
      type: "ADD_ITEM",
      payload: { qty: 14, productName: "Widget", boxes: 1, pieces: 2 },
    });
    expect(describeChangeRequest(cr, lineItems).title).toBe("Add 14 × Widget (1 box + 2 pcs)");
  });

  it("ADD_ITEM with no box split omits the parenthetical", () => {
    const cr = changeRequest({ type: "ADD_ITEM", payload: { qty: 3, productName: "Soda" } });
    expect(describeChangeRequest(cr, lineItems).title).toBe("Add 3 × Soda");
  });

  it("CHANGE_QTY resolves the product name via lineItems and shows the new qty, no $", () => {
    const cr = changeRequest({
      type: "CHANGE_QTY",
      orderItemId: "li1",
      payload: { newQty: 10 },
      note: null,
    });
    const result = describeChangeRequest(cr, lineItems);
    expect(result.title).toBe("Change Widget to qty 10");
    expect(result.detail).toBeNull();
  });

  it("CHANGE_QTY falls back to payload.orderItemId and 'an item' when the line isn't found", () => {
    const cr = changeRequest({
      type: "CHANGE_QTY",
      orderItemId: null,
      payload: { orderItemId: "missing", newQty: 5 },
    });
    expect(describeChangeRequest(cr, lineItems).title).toBe("Change an item to qty 5");
  });

  it("REMOVE_ITEM resolves the product name via lineItems, no $", () => {
    const cr = changeRequest({ type: "REMOVE_ITEM", orderItemId: "li1" });
    expect(describeChangeRequest(cr, lineItems).title).toBe("Remove Widget");
  });

  it("NOTE prefers payload.text over the top-level note", () => {
    const cr = changeRequest({
      type: "NOTE",
      payload: { text: "leave at back door" },
      note: "fallback",
    });
    const result = describeChangeRequest(cr, lineItems);
    expect(result.title).toBe("Note for the driver");
    expect(result.detail).toBe("leave at back door");
  });

  it("NOTE falls back to the top-level note when payload.text is absent", () => {
    const cr = changeRequest({ type: "NOTE", payload: {}, note: "fallback note" });
    expect(describeChangeRequest(cr, lineItems).detail).toBe("fallback note");
  });
});

describe("describeResolution", () => {
  it("PENDING → null", () => {
    expect(describeResolution(changeRequest({ status: "PENDING" }))).toBeNull();
  });

  it("APPROVED + MERGED_AT_STOP → today's delivery copy", () => {
    expect(
      describeResolution(changeRequest({ status: "APPROVED", resolution: "MERGED_AT_STOP" })),
    ).toBe("Approved — applied to today's delivery");
  });

  it("APPROVED + NEXT_DELIVERY → next delivery copy", () => {
    expect(
      describeResolution(changeRequest({ status: "APPROVED", resolution: "NEXT_DELIVERY" })),
    ).toBe("Approved — added to the next delivery");
  });

  it("DECLINED with a reason includes the reason", () => {
    expect(
      describeResolution(changeRequest({ status: "DECLINED", resolutionReason: "out of stock" })),
    ).toBe("Declined — out of stock");
  });

  it("DECLINED without a reason falls back to a bare label", () => {
    expect(describeResolution(changeRequest({ status: "DECLINED", resolutionReason: null }))).toBe(
      "Declined",
    );
  });
});
