import { API_ERROR_CODES } from "@routeflow/types";
import { genericToastCopy } from "./generic-toast-copy";

/** Row 585 (SA-814): a refused delete of an order with delivered units reads as fixed, actionable copy. */
describe("ORDER_DELETE_HAS_DELIVERED copy", () => {
  it("says why the delete was refused and what to do instead", () => {
    const e = {
      message: "Request failed with status code 409",
      response: {
        status: 409,
        data: { code: API_ERROR_CODES.ORDER_DELETE_HAS_DELIVERED, message: "raw server text" },
      },
    };
    expect(genericToastCopy(e)).toBe(
      "This order has delivered items, so it cannot be deleted. Record a return for the delivered goods instead.",
    );
  });
});
