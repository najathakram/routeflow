import {
  customerFilterChipLabel,
  productFilterChipLabel,
  resolveCustomerIdParam,
  resolveProductIdParam,
} from "../lib/customer-order-filter";

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

// PR-B: same rules, extended to the product filter chip (?productId=) so the
// two filters stay independent — each param/label pair is derived the same
// way and neither reads the other's state.
describe("resolveProductIdParam", () => {
  it("keeps a valid id", () => {
    expect(resolveProductIdParam("prod-123")).toBe("prod-123");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveProductIdParam("  prod-123  ")).toBe("prod-123");
  });

  it("treats a missing param as no filter", () => {
    expect(resolveProductIdParam(undefined)).toBeNull();
    expect(resolveProductIdParam(null)).toBeNull();
  });

  it("treats an empty or whitespace-only param as no filter", () => {
    expect(resolveProductIdParam("")).toBeNull();
    expect(resolveProductIdParam("   ")).toBeNull();
  });
});

describe("productFilterChipLabel", () => {
  it("shows the product's name once loaded", () => {
    expect(productFilterChipLabel("Acme Widget")).toBe("Product: Acme Widget");
  });

  it("trims the name", () => {
    expect(productFilterChipLabel("  Acme Widget  ")).toBe("Product: Acme Widget");
  });

  it("falls back to a placeholder while loading or when the name is missing", () => {
    expect(productFilterChipLabel(undefined)).toBe("Product: …");
    expect(productFilterChipLabel(null)).toBe("Product: …");
    expect(productFilterChipLabel("")).toBe("Product: …");
    expect(productFilterChipLabel("   ")).toBe("Product: …");
  });
});
