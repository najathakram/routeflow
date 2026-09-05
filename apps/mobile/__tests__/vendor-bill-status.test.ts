/**
 * Wave E / imp-10b, L-072 — locks `vendorBillPillFor` (extracted from three
 * byte-identical copies in the vendor-bills screens) against the shared,
 * schema-pinned `VendorBillStatus` union. Before the fix, the local union had
 * an invented `"FULL"` value (not a real Prisma value — the real PAID state)
 * and no `"OVERDUE"` branch at all — this spec pins both: every real status
 * has a branch, and `"FULL"` never lands on the "Paid" pill. X4 (review F5)
 * also made the function total: any unrecognized status (including "FULL")
 * now falls through to a neutral `{ variant: "gray", label: <the raw status> }`
 * default instead of returning `undefined`.
 */
import { vendorBillPillFor } from "../lib/vendor-bill-logic";
import type { VendorBillStatus } from "../lib/api/vendor-bills";
import { VENDOR_BILL_STATUS_VALUES } from "@routeflow/types";

describe("vendorBillPillFor", () => {
  it.each(VENDOR_BILL_STATUS_VALUES)("handles every real VendorBillStatus value: %s", (status) => {
    const pill = vendorBillPillFor(status as VendorBillStatus);
    expect(pill).toBeDefined();
    expect(typeof pill.label).toBe("string");
    expect(pill.label.length).toBeGreaterThan(0);
  });

  it("maps PAID to a green 'Paid' pill (not the phantom 'FULL' branch)", () => {
    expect(vendorBillPillFor("PAID")).toEqual({ variant: "green", label: "Paid" });
  });

  it("maps OVERDUE to a red 'Overdue' pill — the value both apps used to omit", () => {
    expect(vendorBillPillFor("OVERDUE")).toEqual({ variant: "red", label: "Overdue" });
  });

  it("has no 'FULL' branch — an invented value from the pre-fix local union falls through to the neutral default, never the 'Paid' pill", () => {
    expect(vendorBillPillFor("FULL" as VendorBillStatus)).toEqual({
      variant: "gray",
      label: "FULL",
    });
  });

  it("an unknown status returns a defined neutral pill with label = the input (X4: total return)", () => {
    const pill = vendorBillPillFor("SOME_FUTURE_STATUS" as VendorBillStatus);
    expect(pill).toBeDefined();
    expect(pill.label).toBe("SOME_FUTURE_STATUS");
  });
});
