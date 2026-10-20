import { customerUpdateData } from "./customer-update-data";

// SA-827 PR2: the staff update writes Customer.invoiceUnitDefault only when the dto carries it.
describe("customerUpdateData — invoiceUnitDefault (SA-827)", () => {
  it.each(["LEGACY", "PIECES", "PACK"] as const)("maps %s onto the write", (value) => {
    expect(customerUpdateData({ invoiceUnitDefault: value } as never)).toMatchObject({
      invoiceUnitDefault: value,
    });
  });

  it("an absent field writes nothing (no accidental reset to LEGACY)", () => {
    expect(customerUpdateData({ phone: "555-0100" } as never)).not.toHaveProperty(
      "invoiceUnitDefault",
    );
  });
});
