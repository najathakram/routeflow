import { mayCompleteAtCounter } from "./complete-at-counter";

/**
 * I-120 (SA-861 rule 2, SA-872 condition 1): ONE predicate for "this staff member may finish an order at the store": the
 * till permission (`mayUseTill`, computed by the caller) AND a business that hands over at the store (the derived
 * fulfilment capability: the PICKUP method, or a counter that is not off). PLAIN inputs only: it lives in
 * @routeflow/pricing because the api never value-imports @routeflow/types (no-runtime-workspace-imports.spec.ts). The api
 * guard and the web + mobile buttons all call it (R11).
 */
const may = (mayUseTill: boolean, methods: readonly string[], counter: string) =>
  mayCompleteAtCounter({ mayUseTill, methods, counter });

describe("mayCompleteAtCounter (R11)", () => {
  it("the till permission AND the PICKUP method: allowed", () => {
    expect(may(true, ["ROUTE", "PICKUP"], "off")).toBe(true);
  });
  it("the till permission AND a counter (always / optional): allowed, with or without PICKUP", () => {
    expect(may(true, ["ROUTE"], "always")).toBe(true);
    expect(may(true, ["ROUTE", "SHIP"], "optional")).toBe(true);
  });
  it("no PICKUP method and the counter off (an unset business): refused, even with the till permission", () => {
    expect(may(true, ["ROUTE", "SHIP"], "off")).toBe(false);
    expect(may(true, [], "off")).toBe(false);
  });
  it("no till permission (an OPERATOR with the ORDERS group off): refused, whatever the business offers", () => {
    expect(may(false, ["ROUTE", "PICKUP"], "always")).toBe(false);
    expect(may(false, ["PICKUP"], "optional")).toBe(false);
  });
  it("an unknown capability (not loaded / unreadable): refused", () => {
    expect(mayCompleteAtCounter({ mayUseTill: true, methods: undefined, counter: undefined })).toBe(
      false,
    );
    expect(mayCompleteAtCounter(null)).toBe(false);
  });
});
