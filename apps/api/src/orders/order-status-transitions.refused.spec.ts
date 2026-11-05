import { BadRequestException } from "@nestjs/common";
import {
  CANCELLABLE_FROM,
  CANCEL_CREDITS_FROM,
  ORDER_STATUS_TRANSITIONS,
  assertOrderStatusTransition,
} from "./order-status-transitions";

/** SA-1101 §2.5: "Deliver again" is REFUSED -> CONFIRMED with no reason; a refused order is never cancelled. */
describe("REFUSED transitions (SA-1101 RO-8, RO-8b)", () => {
  it("RO-8: REFUSED -> CONFIRMED is legal and is not a demotion (no reason needed)", () => {
    expect(ORDER_STATUS_TRANSITIONS.REFUSED).toEqual(["CONFIRMED"]);
    expect(assertOrderStatusTransition("REFUSED", "CONFIRMED", undefined)).toEqual({
      isDeliveredDemotion: false,
    });
  });

  it("RO-8b: REFUSED -> CANCELLED is refused: a cancel credits stock and a return may already have", () => {
    expect(() => assertOrderStatusTransition("REFUSED", "CANCELLED", "x")).toThrow(
      BadRequestException,
    );
    expect(() => assertOrderStatusTransition("REFUSED", "CANCELLED", "x")).toThrow(
      "Cannot transition from REFUSED to CANCELLED",
    );
    expect(CANCELLABLE_FROM).not.toContain("REFUSED");
    expect(CANCEL_CREDITS_FROM).not.toContain("REFUSED");
  });

  it("nothing but office Deliver again leaves REFUSED, and nothing steps INTO it by hand", () => {
    for (const [from, tos] of Object.entries(ORDER_STATUS_TRANSITIONS)) {
      if (from !== "REFUSED") expect(tos).not.toContain("REFUSED");
    }
    for (const to of ["DELIVERED", "PENDING", "PARTIALLY_DELIVERED", "OUT_FOR_DELIVERY"]) {
      expect(() => assertOrderStatusTransition("REFUSED", to, "x")).toThrow(BadRequestException);
    }
  });
});
