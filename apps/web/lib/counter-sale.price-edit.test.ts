import { API_ERROR_CODES } from "@routeflow/types";
import {
  COUNTER_PRICE_EDIT_NOT_PERMITTED_COPY,
  counterSaleErrorCopy,
  isDefinitiveCounterSaleRefusal,
} from "./counter-sale";

/** POS-5: the one 403 that names the price edit, before the generic permission copy. */
const refusal = (status: number, code?: string) => ({ response: { status, data: { code } } });

describe("counterSaleErrorCopy: PRICE_EDIT_NOT_PERMITTED", () => {
  it("the code is in the shared list", () => {
    expect(API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED).toBe("PRICE_EDIT_NOT_PERMITTED");
  });

  it("403 PRICE_EDIT_NOT_PERMITTED has its own exact copy, not the generic permission copy", () => {
    const copy = counterSaleErrorCopy(refusal(403, "PRICE_EDIT_NOT_PERMITTED"));
    expect(copy).toBe(
      "You can't change prices. Remove the line and add it again, or ask your account admin.",
    );
    expect(copy).toBe(COUNTER_PRICE_EDIT_NOT_PERMITTED_COPY);
  });

  it("any other 403 keeps the generic copy, and the counter-sales-off 403 keeps its own", () => {
    expect(counterSaleErrorCopy(refusal(403))).toBe(
      "You don't have permission to complete a counter sale.",
    );
    expect(counterSaleErrorCopy(refusal(401))).toBe(
      "You don't have permission to complete a counter sale.",
    );
    expect(counterSaleErrorCopy(refusal(403, "COUNTER_SALES_DISABLED"))).not.toBe(
      COUNTER_PRICE_EDIT_NOT_PERMITTED_COPY,
    );
  });

  it("the refusal is definitive (nothing was written): the key is dropped, the cart stays editable", () => {
    expect(isDefinitiveCounterSaleRefusal(refusal(403, "PRICE_EDIT_NOT_PERMITTED"))).toBe(true);
  });
});
