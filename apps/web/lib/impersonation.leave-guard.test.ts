import {
  exitImpersonation,
  getImpersonation,
  setImpersonation,
  clearImpersonation,
} from "./impersonation";
import { setCounterCartBusy } from "./counter-cart-signal";

/** POS-7: leaving an impersonation (banner or menu) hard-loads another page: blocked while a counter sale is being recorded. */
afterEach(() => {
  setCounterCartBusy(false);
  clearImpersonation();
});

describe("exitImpersonation leave guard", () => {
  it("does nothing while a counter sale is being recorded", () => {
    setImpersonation("tok", "acme", "admin");
    setCounterCartBusy(true);
    exitImpersonation();
    expect(getImpersonation()).not.toBeNull();
  });
});
