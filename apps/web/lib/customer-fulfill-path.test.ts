import { payloadFulfillPath } from "./customer-fulfill-path";

/**
 * Both rules at once (SA-655 + the fleet-off capability preselect): a PICKUP customer's save omits the
 * field; every other value goes through the account's preselect.
 */
describe("payloadFulfillPath", () => {
  const shipOnly = (v?: string | null) => (v === "SHIP" ? "SHIP" : "SHIP") as "ROUTE" | "SHIP";
  const both = (v?: string | null) => (v === "SHIP" ? "SHIP" : "ROUTE") as "ROUTE" | "SHIP";

  it("omits the field for a PICKUP customer, whatever the account offers", () => {
    expect(payloadFulfillPath("PICKUP", shipOnly)).toBeUndefined();
    expect(payloadFulfillPath("PICKUP", both)).toBeUndefined();
  });

  it("sends the account's preselect for ROUTE / SHIP / unset", () => {
    expect(payloadFulfillPath("ROUTE", shipOnly)).toBe("SHIP"); // ship-only: ROUTE is not offered
    expect(payloadFulfillPath("ROUTE", both)).toBe("ROUTE");
    expect(payloadFulfillPath("SHIP", both)).toBe("SHIP");
    expect(payloadFulfillPath(undefined, both)).toBe("ROUTE");
  });
});
