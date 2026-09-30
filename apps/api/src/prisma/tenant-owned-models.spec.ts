import { isTenantOwnedModel } from "./prisma.service";

/** SA-619 review: the tenant-owned set comes from the generated data model; an empty set would fail open. */
describe("isTenantOwnedModel (SA-619)", () => {
  it("knows the tenant-owned models, including multi-word names (delegate invoicePayment -> InvoicePayment)", () => {
    for (const m of ["Customer", "Invoice", "InvoicePayment", "VendorBillItem", "CreditNote"])
      expect(isTenantOwnedModel(m)).toBe(true);
  });
  it("platform models with no tenantId column are not tenant-owned", () => {
    for (const m of ["Tenant", "PlanVersion"]) expect(isTenantOwnedModel(m)).toBe(false);
  });
  it("the set is non-empty (so a missing DMMF is noticed, not silently permissive)", () => {
    expect(isTenantOwnedModel("Customer")).toBe(true);
  });
});
