import { customerFilterChipLabel, resolveCustomerIdParam } from "../lib/customer-order-filter";

describe("resolveCustomerIdParam", () => {
  it("keeps a valid id", () => {
    expect(resolveCustomerIdParam("cust-123")).toBe("cust-123");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveCustomerIdParam("  cust-123  ")).toBe("cust-123");
  });

  it("treats a missing param as no filter", () => {
    expect(resolveCustomerIdParam(undefined)).toBeNull();
    expect(resolveCustomerIdParam(null)).toBeNull();
  });

  it("treats an empty or whitespace-only param as no filter", () => {
    expect(resolveCustomerIdParam("")).toBeNull();
    expect(resolveCustomerIdParam("   ")).toBeNull();
  });
});

describe("customerFilterChipLabel", () => {
  it("shows the customer's name once loaded", () => {
    expect(customerFilterChipLabel("Acme Wholesale")).toBe("Customer: Acme Wholesale");
  });

  it("trims the name", () => {
    expect(customerFilterChipLabel("  Acme Wholesale  ")).toBe("Customer: Acme Wholesale");
  });

  it("falls back to a placeholder while loading or when the name is missing", () => {
    expect(customerFilterChipLabel(undefined)).toBe("Customer: …");
    expect(customerFilterChipLabel(null)).toBe("Customer: …");
    expect(customerFilterChipLabel("")).toBe("Customer: …");
    expect(customerFilterChipLabel("   ")).toBe("Customer: …");
  });
});
