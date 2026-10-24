import {
  counterVoidBusy,
  counterVoidForeignPayment,
  counterVoidHasReturn,
  counterVoidNotToday,
} from "./counter-sale-void-errors";

describe("counter-sale void refusals (SA-762r)", () => {
  it.each([
    ["busy", counterVoidBusy, 503, "COUNTER_SALE_VOID_BUSY"],
    ["has a return", counterVoidHasReturn, 409, "COUNTER_SALE_VOID_HAS_RETURN"],
    ["foreign payment", counterVoidForeignPayment, 409, "COUNTER_SALE_VOID_FOREIGN_PAYMENT"],
    ["not today", counterVoidNotToday, 409, "COUNTER_SALE_VOID_NOT_TODAY"],
  ])("%s -> %s %s with copy", (_name, make, status, code) => {
    const err = make();
    expect(err.getStatus()).toBe(status);
    expect(err.getResponse()).toEqual({ code, message: expect.stringMatching(/.{20,}/) });
  });
});
