import { buildPayload } from "../lib/customer-payload";
import type { CustomerFormValues } from "../components/CustomerForm";

const emptyCustomerForm = (): CustomerFormValues => ({
  businessName: "",
  contactName: "",
  email: "",
  phone: "",
  creditLimit: "",
  pricingTier: 1,
  currency: "",
  notes: "",
  deliveryWindowStart: "",
  deliveryWindowEnd: "",
  isTaxExempt: false,
  taxId: "",
  fulfillPath: "ROUTE",
  street: "",
  city: "",
  state: "",
  zip: "",
});

describe("customer edit payload end to end (row 285)", () => {
  const loaded = {
    ...emptyCustomerForm(),
    businessName: "Acme",
    phone: "555-0100",
    currency: "CAD",
  };

  it("edit: an emptied loaded phone is sent as null", () => {
    const p = buildPayload({ ...loaded, phone: "" }, loaded, "edit");
    expect(p).toMatchObject({ phone: null });
  });

  it("edit: an emptied loaded currency is never sent (NOT NULL column)", () => {
    const p = buildPayload({ ...loaded, currency: " " }, loaded, "edit") as Record<string, unknown>;
    expect(p.currency).toBeUndefined();
  });

  it("edit: a field that was never loaded stays untouched", () => {
    const p = buildPayload({ ...loaded, notes: "" }, loaded, "edit") as Record<string, unknown>;
    expect(p.notes).toBeUndefined();
  });

  it("create: an empty phone is omitted", () => {
    const empty = { ...emptyCustomerForm(), businessName: "Acme" };
    const p = buildPayload(empty, empty, "create") as Record<string, unknown>;
    expect(p.phone).toBeUndefined();
  });

  // SA-1084 (SI-6): the API no longer returns the stored tax ID, so the edit form loads it blank. A blank
  // field keeps the stored value; a typed one replaces it. (Old native app: payload logic only.)
  it("edit: a tax ID the API did not return stays untouched when blank, and is replaced when typed", () => {
    const p = buildPayload({ ...loaded, taxId: "" }, loaded, "edit") as Record<string, unknown>;
    expect(p.taxId).toBeUndefined();
    const typed = buildPayload({ ...loaded, taxId: " 55-5555555 " }, loaded, "edit") as Record<
      string,
      unknown
    >;
    expect(typed.taxId).toBe("55-5555555");
  });
});
