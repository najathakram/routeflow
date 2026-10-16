import { METER_KEY_VALUES } from "@routeflow/types";
import { meterLabel } from "./billing-meter-label";

describe("meterLabel (M11)", () => {
  it("labels every meter key the server can return, so none prints raw", () => {
    for (const key of METER_KEY_VALUES) {
      const label = meterLabel(key);
      expect(label).not.toBe(key);
      expect(label).toMatch(/^[A-Z].*[a-z]/); // sentence case, not a raw KEY
    }
    expect(meterLabel("CUSTOMERS")).toBe("Customers");
  });

  it("humanises a key it has never heard of", () => {
    expect(meterLabel("ROUTE_STOPS")).toBe("Route stops");
    expect(meterLabel("DRIVERS")).toBe("Drivers");
  });
});
