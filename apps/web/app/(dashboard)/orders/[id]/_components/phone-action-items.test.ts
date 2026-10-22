import { phoneActionItems, type PhoneActionContext } from "./phone-action-items";

/**
 * Row 730 (apple-ux r4 Q19): the order detail's phone "More actions" menu, table-driven over every status x staff/buyer x
 * cancel-blocked, plus the editing, ship, access and delete-gate variants. Each row names the menu the person gets. The
 * conditions mirror the desktop buttons they replace (same status, same access flag, same refusal), so a change to either
 * side fails here before it reaches a phone.
 */
const base: PhoneActionContext = {
  status: "PENDING",
  isEditing: false,
  staff: true,
  canCancel: true,
  cancelBlocked: false,
  canDeleteOpen: true,
  isShip: false,
  returnAvailable: true,
  onRecordReturn: jest.fn(),
  onCancel: jest.fn(),
  onDelete: jest.fn(),
  onUnconfirm: jest.fn(),
  onReturnToConfirmed: jest.fn(),
};
const labels = (over: Partial<PhoneActionContext>) =>
  phoneActionItems({ ...base, ...over }).map((i) => i.label);

type Row = [status: string, who: "staff" | "buyer", blocked: boolean, expected: string[]];

describe("phoneActionItems: status x role x cancel-blocked", () => {
  const rows: Row[] = [
    // staff, nothing blocked
    ["DRAFT", "staff", false, ["Record return", "Delete Draft"]],
    ["PENDING", "staff", false, ["Record return", "Cancel Order", "Delete order"]],
    ["CONFIRMED", "staff", false, ["Record return", "Unconfirm", "Cancel Order", "Delete order"]],
    [
      "OUT_FOR_DELIVERY",
      "staff",
      false,
      ["Record return", "Return to Confirmed", "Cancel Order", "Delete order"],
    ],
    ["DELIVERED", "staff", false, ["Record return"]],
    ["CANCELLED", "staff", false, ["Record return", "Delete order"]],
    // staff, the parcel is with the carrier (server verdict): no Cancel, and no Delete on an open order
    ["DRAFT", "staff", true, ["Record return", "Delete Draft"]],
    ["PENDING", "staff", true, ["Record return"]],
    ["CONFIRMED", "staff", true, ["Record return", "Unconfirm"]],
    ["OUT_FOR_DELIVERY", "staff", true, ["Record return", "Return to Confirmed"]],
    ["DELIVERED", "staff", true, ["Record return"]],
    ["CANCELLED", "staff", true, ["Record return", "Delete order"]],
    // buyer: never Record return, Unconfirm, Return to Confirmed or Delete; Cancel only while the order is theirs to cancel
    ["DRAFT", "buyer", false, ["Cancel Order"]],
    ["PENDING", "buyer", false, ["Cancel Order"]],
    ["CONFIRMED", "buyer", false, []],
    ["OUT_FOR_DELIVERY", "buyer", false, []],
    ["DELIVERED", "buyer", false, []],
    ["CANCELLED", "buyer", false, []],
    ["DRAFT", "buyer", true, []],
    ["PENDING", "buyer", true, []],
    ["CONFIRMED", "buyer", true, []],
    ["OUT_FOR_DELIVERY", "buyer", true, []],
  ];

  it.each(rows)("%s, %s, cancel blocked %s", (status, who, blocked, expected) => {
    expect(labels({ status, staff: who === "staff", cancelBlocked: blocked })).toEqual(expected);
  });
});

describe("phoneActionItems: the other gates", () => {
  it("while editing items, the open-order entries step out (Record return, Unconfirm, Cancel/Delete on an open order)", () => {
    expect(labels({ status: "PENDING", isEditing: true })).toEqual([]);
    expect(labels({ status: "DRAFT", isEditing: true })).toEqual([]);
    expect(labels({ status: "CONFIRMED", isEditing: true })).toEqual([]);
    // a dispatched order is not edited from here: its menu is unchanged
    expect(labels({ status: "OUT_FOR_DELIVERY", isEditing: true })).toEqual([
      "Return to Confirmed",
      "Cancel Order",
      "Delete order",
    ]);
    expect(labels({ status: "CANCELLED", isEditing: true })).toEqual(["Delete order"]);
  });

  it("Record return needs the add-on, whatever the status", () => {
    expect(labels({ status: "DELIVERED", returnAvailable: false })).toEqual([]);
    expect(labels({ status: "PENDING", returnAvailable: false })).toEqual([
      "Cancel Order",
      "Delete order",
    ]);
  });

  it("a buyer's Cancel needs the cancel permission", () => {
    expect(labels({ status: "PENDING", staff: false, canCancel: false })).toEqual([]);
    expect(labels({ status: "DRAFT", staff: false, canCancel: false })).toEqual([]);
  });

  it("staff keep Cancel on CONFIRMED and OUT_FOR_DELIVERY without the buyer cancel permission", () => {
    expect(labels({ status: "CONFIRMED", canCancel: false })).toContain("Cancel Order");
    expect(labels({ status: "OUT_FOR_DELIVERY", canCancel: false })).toContain("Cancel Order");
    // but a PENDING order's Cancel is the permission's
    expect(labels({ status: "PENDING", canCancel: false })).not.toContain("Cancel Order");
  });

  it("Delete on a confirmed or dispatched order needs the page's open-and-uninvoiced gate", () => {
    expect(labels({ status: "CONFIRMED", canDeleteOpen: false })).not.toContain("Delete order");
    expect(labels({ status: "OUT_FOR_DELIVERY", canDeleteOpen: false })).not.toContain(
      "Delete order",
    );
    // Delete of a draft, a pending or a cancelled order does not use that gate
    expect(labels({ status: "PENDING", canDeleteOpen: false })).toContain("Delete order");
    expect(labels({ status: "DRAFT", canDeleteOpen: false })).toContain("Delete Draft");
    expect(labels({ status: "CANCELLED", canDeleteOpen: false })).toContain("Delete order");
  });

  it("a carrier (SHIP) order that left says Unmark shipped, not Return to Confirmed", () => {
    expect(labels({ status: "OUT_FOR_DELIVERY", isShip: true })).toContain("Unmark shipped");
    expect(labels({ status: "OUT_FOR_DELIVERY", isShip: true })).not.toContain(
      "Return to Confirmed",
    );
    expect(labels({ status: "CONFIRMED", isShip: true })).not.toContain("Unmark shipped");
  });

  it("Cancel and Delete are the danger entries, nothing else is", () => {
    const items = phoneActionItems({ ...base, status: "CONFIRMED" });
    expect(items.filter((i) => i.danger).map((i) => i.label)).toEqual([
      "Cancel Order",
      "Delete order",
    ]);
  });

  it("Delete reads Delete Draft only on a draft", () => {
    expect(labels({ status: "DRAFT" })).toContain("Delete Draft");
    for (const status of ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "CANCELLED"]) {
      expect(labels({ status })).not.toContain("Delete Draft");
    }
  });
});

describe("phoneActionItems: every entry runs the SAME handler, a tick after the menu closes", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  it("routes each label to its handler", () => {
    const byLabel = Object.fromEntries(
      phoneActionItems({ ...base, status: "OUT_FOR_DELIVERY" }).map((i) => [i.label, i]),
    );
    const handlers: Record<string, jest.Mock> = {
      "Record return": base.onRecordReturn as jest.Mock,
      "Return to Confirmed": base.onReturnToConfirmed as jest.Mock,
      "Cancel Order": base.onCancel as jest.Mock,
      "Delete order": base.onDelete as jest.Mock,
    };
    for (const [label, handler] of Object.entries(handlers)) {
      byLabel[label].onSelect();
      expect(handler).not.toHaveBeenCalled(); // not synchronously: the menu is still closing
      jest.runAllTimers();
      expect(handler).toHaveBeenCalledTimes(1);
    }
    const unconfirm = phoneActionItems({ ...base, status: "CONFIRMED" }).find(
      (i) => i.label === "Unconfirm",
    )!;
    unconfirm.onSelect();
    jest.runAllTimers();
    expect(base.onUnconfirm).toHaveBeenCalledTimes(1);
  });
});
