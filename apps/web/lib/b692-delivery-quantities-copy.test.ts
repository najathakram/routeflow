import { API_ERROR_CODES } from "@routeflow/types";
import { describeCancelImpact } from "./cancel-impact";
import { genericToastCopy } from "./generic-toast-copy";

/**
 * B692 (SA-814 R4-3): the two new 409 codes read as fixed, actionable copy (never the neutral conflict
 * sentence), and cancel-impact's `deliveryQuantitiesMissing` refusal explains itself.
 */
const err = (code: string) => ({
  message: "Request failed with status code 409",
  response: { status: 409, data: { code, message: "raw server text" } },
});

describe("B692 error copy", () => {
  it("ORDER_PD_NEEDS_QUANTITIES tells the operator what to do", () => {
    expect(genericToastCopy(err(API_ERROR_CODES.ORDER_PD_NEEDS_QUANTITIES))).toBe(
      "Record what was delivered for each line first.",
    );
  });

  it("ORDER_DELIVERY_QUANTITIES_MISSING names the gap", () => {
    expect(genericToastCopy(err(API_ERROR_CODES.ORDER_DELIVERY_QUANTITIES_MISSING))).toBe(
      "Delivery quantities are missing; set them before cancelling.",
    );
  });
});

describe("B692 cancel-impact copy", () => {
  const base = {
    invoicesToVoid: [],
    creditsToRestore: [],
    advanceToRestore: 0,
    blockingPayments: [],
  };

  it("a delivered order with no recorded quantities is refused with its own sentence", () => {
    const copy = describeCancelImpact({
      ...base,
      canCancel: false,
      deliveredUnits: 0,
      deliveryQuantitiesMissing: true,
    });
    expect(copy.blockedReason).toBe("Delivery quantities are missing; set them before cancelling.");
    expect(copy.confirmLabel).toBeNull();
  });

  it("an absent flag (an older API) keeps today's generic refusal", () => {
    const copy = describeCancelImpact({ ...base, canCancel: false, deliveredUnits: 0 });
    expect(copy.blockedReason).toBe("This order can't be cancelled right now.");
  });
});
