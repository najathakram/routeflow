import { BILLING_EVENTS, BILLING_EVENT_LABELS } from "./plan-catalog.constants";

/**
 * R-2 (SA-1297): the staff refund's BillingEvent type and the one partial label map beside BILLING_EVENTS.
 * The label is applied on read by the billing-events list; the web keeps no map of its own.
 */
describe("R-2: the refund.staff event type and its label", () => {
  it("BILLING_EVENTS.STAFF_REFUND_RECORDED is exactly refund.staff", () => {
    expect(BILLING_EVENTS.STAFF_REFUND_RECORDED).toBe("refund.staff");
  });

  it("BILLING_EVENT_LABELS names only refund.staff, as Staff refund (every other type reads label null)", () => {
    expect(BILLING_EVENT_LABELS).toEqual({ "refund.staff": "Staff refund" });
  });

  it("every labelled type is a declared BILLING_EVENTS value", () => {
    const declared = new Set<string>(Object.values(BILLING_EVENTS));
    for (const type of Object.keys(BILLING_EVENT_LABELS)) expect(declared.has(type)).toBe(true);
  });
});
