/**
 * POS mode (SA-763r P-2) pure logic: preference seeding, the progress steps, the per-state action
 * selection (one primary per state), and the fixed copy the brief pins.
 */
import {
  POS_COPY,
  POS_MODE_PREF_KEY,
  posCanSwitchToDelivery,
  posCutNote,
  posFinishFailureMessage,
  posFinishSuccessMessage,
  posLiveInvoices,
  posMergePrompt,
  posModeFromPreferences,
  posModePrefPatch,
  posOrderActions,
  posProgressSteps,
} from "../lib/pos-mode";

const inv = (status: string, id = "i1") => ({ id, status });
const keys = (a: { key: string }[]) => a.map((x) => x.key);

describe("POS preference", () => {
  it("is keyed orders.posMode; unset and anything but 'true' is off", () => {
    expect(POS_MODE_PREF_KEY).toBe("orders.posMode");
    expect(posModeFromPreferences(undefined)).toBe(false);
    expect(posModeFromPreferences({})).toBe(false);
    expect(posModeFromPreferences({ "orders.posMode": "false" })).toBe(false);
    expect(posModeFromPreferences({ "orders.posMode": "true" })).toBe(true);
  });
  it("PATCHes the string form", () => {
    expect(posModePrefPatch(true)).toEqual({ "orders.posMode": "true" });
    expect(posModePrefPatch(false)).toEqual({ "orders.posMode": "false" });
  });
});

describe("posOrderActions", () => {
  it("PENDING: only Switch to delivery (Confirm lives in the status bar)", () => {
    expect(keys(posOrderActions({ invoices: [] }, "PENDING"))).toEqual(["switchToDelivery"]);
  });
  it("CONFIRMED without an invoice: Create invoice is the one primary, Hand over secondary", () => {
    const a = posOrderActions({ invoices: [] }, "CONFIRMED");
    expect(keys(a)).toEqual(["createInvoice", "handOver", "readyForPickup", "switchToDelivery"]);
    expect(a.filter((x) => x.tier === "primary").map((x) => x.key)).toEqual(["createInvoice"]);
  });
  it("CONFIRMED with an invoice: Hand over is the one primary; Ready for pickup stays secondary", () => {
    const a = posOrderActions({ invoices: [inv("DRAFT")] }, "CONFIRMED");
    expect(keys(a)).toEqual(["handOver", "readyForPickup", "switchToDelivery"]);
    expect(a.filter((x) => x.tier === "primary").map((x) => x.key)).toEqual(["handOver"]);
    expect(a.find((x) => x.key === "readyForPickup")?.tier).toBe("secondary");
  });
  it("a VOID invoice does not count: Create invoice is still offered", () => {
    expect(keys(posOrderActions({ invoices: [inv("VOID")] }, "CONFIRMED"))[0]).toBe(
      "createInvoice",
    );
  });
  it("once Ready for pickup (OUT_FOR_DELIVERY) the notification is not offered again", () => {
    const a = posOrderActions({ invoices: [inv("DRAFT")] }, "OUT_FOR_DELIVERY");
    expect(keys(a)).toEqual(["handOver", "switchToDelivery"]);
  });
  it("DELIVERED: Record payment until every live invoice is PAID, then Print", () => {
    const due = posOrderActions({ invoices: [inv("SENT", "a"), inv("PAID", "b")] }, "DELIVERED");
    expect(due).toEqual([
      { key: "recordPayment", label: POS_COPY.recordPayment, tier: "primary", invoiceId: "a" },
    ]);
    const paid = posOrderActions({ invoices: [inv("PAID", "a"), inv("VOID", "b")] }, "DELIVERED");
    expect(paid[0]).toMatchObject({ key: "printInvoice", invoiceId: "a" });
    expect(posOrderActions({ invoices: [] }, "DELIVERED")).toEqual([]);
  });
  it("offers no DELIVERED / Out-for-delivery status action by any key", () => {
    for (const st of ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"]) {
      expect(keys(posOrderActions({ invoices: [inv("SENT")] }, st))).not.toContain("markDelivered");
    }
  });
  it("Switch to delivery only while the order is open", () => {
    expect(posCanSwitchToDelivery("CONFIRMED")).toBe(true);
    expect(posCanSwitchToDelivery("DELIVERED")).toBe(false);
  });
});

describe("posProgressSteps", () => {
  const done = (o: { invoices?: { id: string; status: string }[] }, st: string) =>
    posProgressSteps(o, st).map((s) => s.done);
  it("is Confirmed -> Invoice (draft) -> Handed over with no delivery step", () => {
    const steps = posProgressSteps({ invoices: [] }, "CONFIRMED");
    expect(steps.map((s) => s.label)).toEqual(["Confirmed", "Invoice (draft)", "Handed over"]);
    expect(done({ invoices: [] }, "CONFIRMED")).toEqual([true, false, false]);
  });
  it("the invoice reads '(draft)' until every live invoice is issued", () => {
    expect(posProgressSteps({ invoices: [inv("DRAFT")] }, "CONFIRMED")[1]).toMatchObject({
      label: "Invoice (draft)",
      done: true,
    });
    expect(posProgressSteps({ invoices: [inv("SENT")] }, "CONFIRMED")[1].label).toBe("Invoice");
  });
  it("DELIVERED completes the third step; PENDING completes none", () => {
    expect(done({ invoices: [inv("SENT")] }, "DELIVERED")).toEqual([true, true, true]);
    expect(done({ invoices: [] }, "PENDING")).toEqual([false, false, false]);
  });
  it("ignores VOID invoices", () => {
    expect(posLiveInvoices({ invoices: [inv("VOID")] })).toEqual([]);
    expect(done({ invoices: [inv("VOID")] }, "CONFIRMED")[1]).toBe(false);
  });
});

describe("copy and half-failure messaging", () => {
  it("names the missing half of Confirm & invoice", () => {
    expect(posFinishFailureMessage("confirm")).toBe(
      "Order created, but it couldn't be confirmed. Open it to confirm.",
    );
    expect(posFinishFailureMessage("invoice")).toBe(
      "Order confirmed, but the invoice wasn't created. Open it and choose Create invoice.",
    );
    expect(posFinishSuccessMessage(true)).toBe("Order confirmed and invoiced");
    expect(posFinishSuccessMessage(false)).toBe("Order confirmed");
  });
  it("MERGE_CHOICE_REQUIRED copy; a backdated order cannot be added to", () => {
    expect(posMergePrompt(false)).toMatchObject({
      title: "This customer already has an open counter order",
      addLabel: "Add to it",
      newLabel: "Start a new one",
    });
    expect(posMergePrompt(true).message).toMatch(/backdated order has to be created separately/);
  });
  it("the cut-after-hand-over note shows only on a handed-over POS order", () => {
    const note =
      "Cutting items after hand-over doesn't put them back on the shelf. If the goods came back, record a return.";
    expect(posCutNote({ fulfillPath: "PICKUP", counterSale: false }, "DELIVERED")).toBe(note);
    expect(posCutNote({ fulfillPath: "PICKUP", counterSale: false }, "CONFIRMED")).toBeNull();
    expect(posCutNote({ fulfillPath: "PICKUP", counterSale: true }, "DELIVERED")).toBeNull();
    expect(posCutNote({ fulfillPath: "ROUTE" }, "DELIVERED")).toBeNull();
  });
});
