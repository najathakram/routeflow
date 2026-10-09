import { formFulfillPath, writableFulfillPath } from "../lib/customer-fulfill-path";

/**
 * SA-655: CustomerForm used to coerce anything that is not SHIP to ROUTE, silently rewriting a PICKUP
 * customer on save. The form value now preserves PICKUP; because the write API refuses PICKUP as a
 * customer default, the PAYLOAD omits it (the server keeps the stored value).
 */
describe("customer fulfilment path (form <-> payload)", () => {
  it("formFulfillPath preserves ROUTE, SHIP and PICKUP; anything else (missing, legacy) is ROUTE", () => {
    expect(formFulfillPath("ROUTE")).toBe("ROUTE");
    expect(formFulfillPath("SHIP")).toBe("SHIP");
    expect(formFulfillPath("PICKUP")).toBe("PICKUP");
    expect(formFulfillPath(undefined)).toBe("ROUTE");
    expect(formFulfillPath("bogus")).toBe("ROUTE");
  });

  it("writableFulfillPath sends ROUTE and SHIP, and omits PICKUP so a save never rewrites it", () => {
    expect(writableFulfillPath("ROUTE")).toBe("ROUTE");
    expect(writableFulfillPath("SHIP")).toBe("SHIP");
    expect(writableFulfillPath("PICKUP")).toBeUndefined();
  });

  it("a PICKUP customer round-trips: load -> save payload carries no fulfillPath", () => {
    expect(writableFulfillPath(formFulfillPath("PICKUP"))).toBeUndefined();
  });
});
